import { createPool, getMigrationStatus, runMigrations } from '../index';

/**
 * Release-time migration command (Phase 13). Used by the release job before
 * a new API version starts (docs/deployment.md → Release).
 *
 * - `--status`: report pending migrations and change nothing.
 * - Production requires CAPTAIN_MIGRATE_CONFIRM_DATABASE to equal the target
 *   database name: an explicit, per-release confirmation that a fresh backup
 *   exists and the change was reviewed. Never run from development tooling.
 */
export async function runMigrateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
): Promise<number> {
  const appEnv = env.APP_ENV;
  const url = env.DATABASE_URL;
  const statusOnly = argv.includes('--status');
  if (!appEnv || !url) {
    log('migrate: APP_ENV and DATABASE_URL must be set.');
    return 1;
  }
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    log('migrate: DATABASE_URL is not a valid URL.');
    return 1;
  }
  if (appEnv === 'production' && !statusOnly && env.CAPTAIN_MIGRATE_CONFIRM_DATABASE !== database) {
    log(
      'migrate: refusing to change a production database without CAPTAIN_MIGRATE_CONFIRM_DATABASE set to its name (take and verify a backup first).',
    );
    return 1;
  }
  const pool = createPool({ connectionString: url, max: 1 });
  try {
    const before = await getMigrationStatus(pool);
    if (statusOnly) {
      log(
        `migrate: ${before.applied} applied, ${before.pending.length} pending${before.pending.length ? `: ${before.pending.join(', ')}` : ''}.`,
      );
      return 0;
    }
    await runMigrations(pool);
    const after = await getMigrationStatus(pool);
    log(
      `migrate: applied ${before.pending.length} migration(s); ${after.applied} recorded, ${after.pending.length} pending.`,
    );
    return after.pending.length === 0 ? 0 : 1;
  } catch (error) {
    log(`migrate: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}
