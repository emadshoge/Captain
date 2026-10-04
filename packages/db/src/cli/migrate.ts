// Applies pending migrations to DATABASE_URL.
// Refuses to run against production: production migrations will have their own
// reviewed procedure (implementation plan, Phases 15 and 17).
import { createPool, getMigrationStatus, runMigrations } from '../index';

const appEnv = process.env.APP_ENV;
const url = process.env.DATABASE_URL;

if (!appEnv || !url) {
  console.error('db:migrate: APP_ENV and DATABASE_URL must be set.');
  process.exit(1);
}
if (appEnv === 'production') {
  console.error('db:migrate: refusing to migrate a production database from this command.');
  process.exit(1);
}

const pool = createPool({ connectionString: url, max: 1 });
try {
  const before = await getMigrationStatus(pool);
  await runMigrations(pool);
  const after = await getMigrationStatus(pool);
  console.log(
    `db:migrate: applied ${before.pending.length} migration(s); ${after.applied} recorded, ${after.pending.length} pending.`,
  );
} catch (error) {
  console.error('db:migrate: failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
