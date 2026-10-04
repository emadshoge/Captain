import { ConfigError, loadApiConfig } from '@captain/config';
import { redactDeep } from '@captain/logging';
import { buildApp } from './app';

let config;
try {
  config = loadApiConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    // Messages name variables only, never their values.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const app = await buildApp({ config });
app.log.info({ config: redactDeep(config) }, 'configuration loaded');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
