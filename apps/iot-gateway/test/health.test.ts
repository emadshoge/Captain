import type { AddressInfo } from 'node:net';
import { loadGatewayConfig } from '@captain/config';
import { describe, expect, it } from 'vitest';
import { createHealthServer, gatewayHealth } from '../src/health';

describe('iot-gateway health', () => {
  it('reports that no device protocol is implemented', () => {
    const health = gatewayHealth(loadGatewayConfig({ APP_ENV: 'test' }));
    expect(health).toEqual({
      status: 'ok',
      service: 'captain-iot-gateway',
      adapter: 'none',
      protocol: 'not_implemented',
      simulated: false,
    });
  });

  it('labels a simulated adapter as simulated', () => {
    const health = gatewayHealth(
      loadGatewayConfig({ APP_ENV: 'development', DEVICE_ADAPTER: 'simulated' }),
    );
    expect(health.simulated).toBe(true);
  });

  it('serves GET /health over HTTP and 404s other paths', async () => {
    const server = createHealthServer(loadGatewayConfig({ APP_ENV: 'test' }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: 'ok', protocol: 'not_implemented' });
      const missing = await fetch(`http://127.0.0.1:${port}/commands`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
