import type { AddressInfo } from 'node:net';
import { loadGatewayConfig } from '@captain/config';
import { createLogger } from '@captain/logging';
import { describe, expect, it } from 'vitest';
import { createHealthServer, gatewayHealth } from '../src/health';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'captain-iot-gateway',
    level: 'trace',
    appEnv: 'test',
    destination: { write: (line: string) => void lines.push(line) },
  });
  return { logger, lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

async function listen(headersCheck: (base: string) => Promise<void>) {
  const { logger, lines, entries } = capture();
  const server = createHealthServer(loadGatewayConfig({ APP_ENV: 'test' }), logger);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await headersCheck(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return { lines, entries };
}

describe('iot-gateway health', () => {
  it('reports that no device protocol is implemented', () => {
    expect(gatewayHealth(loadGatewayConfig({ APP_ENV: 'test' }))).toEqual({
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

  it('serves GET /health and returns a standard 404 error for other paths', async () => {
    await listen(async (base) => {
      const ok = await fetch(`${base}/health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: 'ok', protocol: 'not_implemented' });
      const missing = await fetch(`${base}/commands`);
      expect(missing.status).toBe(404);
      const body = (await missing.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: 'NOT_FOUND',
        requestId: missing.headers.get('x-request-id'),
      });
    });
  });
});

describe('iot-gateway request IDs and logs', () => {
  it('returns and logs a request ID per request', async () => {
    let returned: string | null = null;
    const { entries } = await listen(async (base) => {
      const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'probe-1' } });
      returned = res.headers.get('x-request-id');
    });
    expect(returned).toBe('probe-1');
    expect(entries()).toEqual([
      expect.objectContaining({
        level: 'debug',
        service: 'captain-iot-gateway',
        requestId: 'probe-1',
        msg: 'request completed',
        res: { statusCode: 200 },
      }),
    ]);
  });

  it('replaces unsafe request IDs and redacts sensitive query values', async () => {
    const { lines } = await listen(async (base) => {
      const res = await fetch(`${base}/x?token=gw-secret-1`, {
        headers: { 'x-request-id': 'bad id {x}' },
      });
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });
    const text = lines.join('');
    expect(text).not.toContain('gw-secret-1');
    expect(text).not.toContain('bad id');
  });
});
