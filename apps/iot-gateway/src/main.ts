import { ConfigError, loadGatewayConfig } from '@captain/config';
import { createHealthServer } from './health';

let config;
try {
  config = loadGatewayConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const server = createHealthServer(config);
server.listen(config.HEALTH_PORT, config.HOST, () => {
  console.log(
    JSON.stringify({
      msg: 'iot-gateway started (no device protocol implemented)',
      adapter: config.DEVICE_ADAPTER,
      port: config.HEALTH_PORT,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
