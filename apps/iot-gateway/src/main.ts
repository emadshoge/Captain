import { type GatewayConfig, ConfigError, loadGatewayConfig } from '@captain/config';
import { createLogger, redactDeep } from '@captain/logging';
import { SimulatedDeviceAdapter } from './adapters/simulated';
import { InternalApiClient } from './api-client';
import { Gateway } from './gateway';
import { createHealthServer } from './health';

let config: GatewayConfig;
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

let gateway: Gateway | null = null;
if (config.DEVICE_ADAPTER === 'simulated') {
  logger.warn(
    { adapter: 'simulated' },
    'SIMULATED device adapter selected: no real hardware is connected',
  );
  gateway = new Gateway(
    new SimulatedDeviceAdapter({
      telemetryIntervalMs: config.SIM_TELEMETRY_INTERVAL_SECONDS * 1000,
    }),
    new InternalApiClient(config.API_INTERNAL_URL, config.INTERNAL_API_TOKEN),
    logger,
    { commandPollIntervalMs: config.COMMAND_POLL_INTERVAL_MS },
  );
  await gateway.start();
} else {
  // The real supplier adapter is blocked on supplier documentation (D-IOT).
  logger.info('no device adapter configured; serving health only');
}

const server = createHealthServer(config, logger, gateway ? () => gateway!.getStats() : undefined);
server.listen(config.HEALTH_PORT, config.HOST, () => {
  logger.info(
    { adapter: config.DEVICE_ADAPTER, port: config.HEALTH_PORT },
    'iot-gateway started (no supplier protocol implemented)',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    void (gateway?.stop() ?? Promise.resolve()).finally(() => server.close(() => process.exit(0)));
  });
}
