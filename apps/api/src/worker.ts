/**
 * Background worker: periodic sweeps (command timeouts, offline devices,
 * stale telemetry, housekeeping; later reservations and payment
 * reconciliation). Safe to run more than one instance: an advisory lock
 * keeps sweeps single-active.
 */
import { type ApiConfig, ConfigError, loadApiConfig } from '@captain/config';
import { createPool } from '@captain/db';
import { createLogger, redactDeep } from '@captain/logging';
import { initRideEngine } from './rides/engine';
import { runSweepsOnce } from './worker/sweeps';
import { createPaymentProvider } from './wallet/providers';

let config: ApiConfig;
try {
  config = loadApiConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({
  service: 'captain-worker',
  level: config.LOG_LEVEL,
  appEnv: config.APP_ENV,
});
const pool = createPool({ connectionString: config.DATABASE_URL, max: 3 });
const provider = createPaymentProvider(config);
initRideEngine({ config, pool, now: () => new Date() });
const INTERVAL_MS = 5_000;
let stopping = false;

logger.info({ config: redactDeep(config) }, 'worker starting');

async function loop() {
  while (!stopping) {
    try {
      const results = await runSweepsOnce({ config, pool, now: () => new Date(), provider });
      if (results === null) logger.debug('another worker holds the sweep lock');
      else if (Object.values(results).some((n) => n > 0))
        logger.info({ results }, 'sweeps completed');
    } catch (error) {
      logger.error({ err: error }, 'sweep failed');
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  await pool.end();
  logger.info('worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}
void loop();
