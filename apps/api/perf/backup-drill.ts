/**
 * Backup and restore drill (Phase 13). Builds a throwaway database with
 * labelled data, takes a `pg_dump` custom-format backup, restores it into a
 * fresh database and verifies row counts, the ledger, the migration record
 * and that the database rules (append-only triggers, balance checks) survived.
 *
 * Needs TEST_DATABASE_ADMIN_URL and pg_dump/pg_restore matching the server
 * major version. Usage: pnpm --filter @captain/api backup-drill
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@captain/db';
import { createTestDatabase } from '@captain/db/testing';
import { fundRider, seedScooters, setupDatabase } from './lib';

const TABLES = [
  'scooters',
  'devices',
  'device_assignments',
  'riders',
  'ledger_accounts',
  'journal_entries',
  'ledger_lines',
  'pricing_plans',
  'zones',
  'audit_log',
  'drizzle.__drizzle_migrations',
];

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result;
}

async function counts(url: string) {
  const pool = createPool({ connectionString: url, max: 1 });
  try {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      out[table] = (
        await pool.query<{ n: number }>(`select count(*)::int n from ${table}`)
      ).rows[0]!.n;
    }
    out.ledger_sum = Number(
      (
        await pool.query<{ s: string }>(
          `select coalesce(sum(amount_santim),0)::bigint s from ledger_lines`,
        )
      ).rows[0]!.s,
    );
    return out;
  } finally {
    await pool.end();
  }
}

async function main() {
  const source = await setupDatabase();
  const work = mkdtempSync(join(tmpdir(), 'captain-backup-drill-'));
  const target = await createTestDatabase();
  try {
    // Labelled data: PERF scooters, riders with ledger entries, an audit row.
    await seedScooters(source.pool, 50);
    for (let i = 0; i < 20; i++) {
      const rider = await source.pool.query<{ id: string }>(
        `insert into riders default values returning id`,
      );
      await fundRider(source.pool, rider.rows[0]!.id, 10_000 + i);
    }
    await source.pool.query(
      `insert into audit_log (actor_type, action, target_type, reason) values ('system', 'drill.backup', 'database', 'backup drill marker')`,
    );
    const before = await counts(source.db.url);

    const file = join(work, 'captain.dump');
    const dumpStarted = Date.now();
    run('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${file}`,
      source.db.url,
    ]);
    const dumpMs = Date.now() - dumpStarted;
    const restoreStarted = Date.now();
    run('pg_restore', [
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      `--dbname=${target.url}`,
      file,
    ]);
    const restoreMs = Date.now() - restoreStarted;
    const after = await counts(target.url);

    const mismatches = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (mismatches.length)
      throw new Error(
        `restored data differs: ${mismatches.map((k) => `${k} ${before[k]}→${after[k]}`).join(', ')}`,
      );
    if (after.ledger_sum !== 0) throw new Error('restored ledger does not balance');

    // Database rules must survive the restore.
    const pool = createPool({ connectionString: target.url, max: 1 });
    try {
      const appendOnly = await pool
        .query(`update ledger_lines set amount_santim = amount_santim where true`)
        .then(
          () => 'allowed',
          () => 'refused',
        );
      if (appendOnly !== 'refused')
        throw new Error('append-only ledger trigger missing after restore');
      const unbalanced = await (async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const j = await client.query<{ id: string }>(
            `insert into journal_entries (kind, reference_type, reference_id, description, created_by_type)
             values ('adjustment', 'drill', 'unbalanced', 'should fail', 'system') returning id`,
          );
          const account = await client.query<{ id: string }>(
            `select id from ledger_accounts limit 1`,
          );
          await client.query(
            `insert into ledger_lines (journal_id, account_id, amount_santim) values ($1, $2, 1)`,
            [j.rows[0]!.id, account.rows[0]!.id],
          );
          await client.query('commit');
          return 'committed';
        } catch {
          await client.query('rollback').catch(() => undefined);
          return 'refused';
        } finally {
          client.release();
        }
      })();
      if (unbalanced !== 'refused') throw new Error('balanced-journal check missing after restore');
    } finally {
      await pool.end();
    }

    const size = statSync(file).size;
    console.log(
      JSON.stringify(
        {
          result: 'PASS',
          dumpMs,
          restoreMs,
          dumpBytes: size,
          rows: after,
          checks: [
            'row counts equal',
            'ledger balanced',
            'append-only trigger',
            'balanced-journal check',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    await source.pool.end();
    await source.db.drop();
    await target.drop();
  }
}

main().catch((error: unknown) => {
  console.error('BACKUP DRILL FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
