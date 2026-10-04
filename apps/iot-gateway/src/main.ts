import { ConfigError, loadGatewayConfig } from '@captain/config';
import { createLogger, redactDeep } from '@captain/logging';
import { createHealthServer } from './health';

let config;
try {
  config = loadGatewayConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    // Messages name variables only, never their values.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({
  service: 'captain-iot-gateway',
  level: config.LOG_LEVEL,
  appEnv: config.APP_ENV,
});
logger.info({ config: redactDeep(config) }, 'configuration loaded');
if (config.DEVICE_ADAPTER === 'simulated') {
  logger.warn(
    { adapter: 'simulated' },
    'SIMULATED device adapter selected: no real hardware is connected',
  );
}

const server = createHealthServer(config, logger);
server.listen(config.HEALTH_PORT, config.HOST, () => {
  logger.info(
    { adapter: config.DEVICE_ADAPTER, port: config.HEALTH_PORT },
    'iot-gateway started (no device protocol implemented)',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
