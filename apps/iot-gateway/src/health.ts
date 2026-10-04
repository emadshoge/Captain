import { createServer, type Server } from 'node:http';
import type { GatewayConfig } from '@captain/config';
import type { HealthResponse } from '@captain/contracts';

export interface GatewayHealth extends HealthResponse {
  adapter: GatewayConfig['DEVICE_ADAPTER'];
  /** No supplier protocol exists until supplier documentation arrives. */
  protocol: 'not_implemented';
  simulated: boolean;
}

export function gatewayHealth(config: GatewayConfig): GatewayHealth {
  return {
    status: 'ok',
    service: 'captain-iot-gateway',
    adapter: config.DEVICE_ADAPTER,
    protocol: 'not_implemented',
    simulated: config.DEVICE_ADAPTER === 'simulated',
  };
}

/** Minimal HTTP server exposing GET /health; everything else is 404. */
export function createHealthServer(config: GatewayConfig): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(gatewayHealth(config)));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });
}
