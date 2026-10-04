import { createServer, type Server } from 'node:http';
import type { GatewayConfig } from '@captain/config';
import type { ErrorResponse, HealthResponse } from '@captain/contracts';
import { REQUEST_ID_HEADER, redactUrl, resolveRequestId, type Logger } from '@captain/logging';

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

/**
 * Minimal HTTP server exposing GET /health; everything else is 404.
 * Every response carries x-request-id, and each request is logged with it.
 * Headers and bodies are never logged.
 */
export function createHealthServer(config: GatewayConfig, logger: Logger): Server {
  return createServer((req, res) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    const log = logger.child({ requestId });
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader('content-type', 'application/json');

    let status: number;
    if (req.method === 'GET' && req.url === '/health') {
      status = 200;
      res.writeHead(status);
      res.end(JSON.stringify(gatewayHealth(config)));
    } else {
      status = 404;
      const body: ErrorResponse = {
        error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId },
      };
      res.writeHead(status);
      res.end(JSON.stringify(body));
    }
    // Health probes are frequent: keep them at debug; anything else at info.
    log[status === 200 ? 'debug' : 'info'](
      { req: { method: req.method, url: redactUrl(req.url ?? '') }, res: { statusCode: status } },
      'request completed',
    );
  });
}
