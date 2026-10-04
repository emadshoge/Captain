// Loads labelled development fixtures into DATABASE_URL (development/test only).
import { createPool } from '../client';
import { loadDevFixtures } from '../fixtures';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('db:fixtures: DATABASE_URL must be set.');
  process.exit(1);
}
const pool = createPool({ connectionString: url, max: 1 });
try {
  const summary = await loadDevFixtures(pool);
  console.log(
    `db:fixtures: loaded ${summary.scooters} simulated scooters, ${summary.zones} zones, DEV FIXTURE pricing.`,
  );
} catch (error) {
  console.error('db:fixtures:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
