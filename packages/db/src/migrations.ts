import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDb } from './client';

/** Drizzle's bookkeeping table (drizzle-orm default). */
const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';

/**
 * Locates the SQL migrations folder. Candidates, in order:
 * - `CAPTAIN_MIGRATIONS_DIR` (explicit override),
 * - `./migrations` next to the running bundle (the API build copies it there),
 * - `packages/db/migrations` when running from source.
 */
export function resolveMigrationsFolder(
  env: Record<string, string | undefined> = process.env,
): string {
  const candidates = [
    env.CAPTAIN_MIGRATIONS_DIR,
    fileURLToPath(new URL('./migrations', import.meta.url)),
    fileURLToPath(new URL('../migrations', import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((dir) => existsSync(`${dir}/meta/_journal.json`));
  if (!found) {
    throw new Error(`Migrations folder not found. Looked in: ${candidates.join(', ')}`);
  }
  return found;
}

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

function readJournal(folder: string): Journal {
  return JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as Journal;
}

export async function runMigrations(
  pool: pg.Pool,
  folder = resolveMigrationsFolder(),
): Promise<void> {
  await migrate(createDb(pool), { migrationsFolder: folder });
}

export interface MigrationStatus {
  applied: number;
  pending: string[];
}

/**
 * Compares the migrations on disk with those recorded in the database, using
 * the same rule as drizzle's migrator (a migration is applied when its
 * journal timestamp is <= the latest recorded `created_at`).
 */
export async function getMigrationStatus(
  pool: pg.Pool,
  folder = resolveMigrationsFolder(),
): Promise<MigrationStatus> {
  const journal = readJournal(folder);
  const exists = await pool.query<{ exists: boolean }>(
    `select to_regclass($1) is not null as exists`,
    [MIGRATIONS_TABLE],
  );
  if (!exists.rows[0]?.exists) {
    return { applied: 0, pending: journal.entries.map((entry) => entry.tag) };
  }
  const result = await pool.query<{ applied: string; last: string | null }>(
    `select count(*) as applied, max(created_at)::text as last from ${MIGRATIONS_TABLE}`,
  );
  const row = result.rows[0];
  const last = row?.last == null ? -1 : Number(row.last);
  return {
    applied: Number(row?.applied ?? 0),
    pending: journal.entries.filter((entry) => entry.when > last).map((entry) => entry.tag),
  };
}
