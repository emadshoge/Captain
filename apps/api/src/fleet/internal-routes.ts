import {
  COMMON_ERROR_CODES,
  InternalCommandResultResponseSchema,
  InternalCommandResultSchema,
  InternalDeviceSchema,
  InternalPendingCommandSchema,
  InternalTelemetryBatchSchema,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors';
import { safeEqual } from '../lib/crypto';
import {
  type FleetDeps,
  fetchPendingCommands,
  ingestTelemetry,
  recordCommandResult,
} from './service';

const AdapterQuery = z.object({ adapter: z.enum(['simulated', 'supplier_tcp']) });

/**
 * Gateway-facing endpoints under /internal/v1. Authenticated with a shared
 * service token (constant-time compare); must only be reachable on the
 * private network (docs/deployment.md). Simulated traffic is refused in production.
 */
export const internalRoutes: FastifyPluginAsyncZod<{ deps: FleetDeps }> = async (app, { deps }) => {
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    const token = /^Bearer (\S+)$/.exec(header)?.[1] ?? '';
    if (!token || !safeEqual(token, deps.config.INTERNAL_API_TOKEN)) {
      throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
    }
  });

  const refuseSimulatedInProduction = (adapter: string) => {
    if (adapter === 'simulated' && deps.config.APP_ENV === 'production') {
      throw new AppError(
        403,
        COMMON_ERROR_CODES.FORBIDDEN,
        'Simulated devices are not allowed in production.',
      );
    }
  };

  app.get(
    '/internal/v1/devices',
    { schema: { querystring: AdapterQuery, response: { 200: z.array(InternalDeviceSchema) } } },
    async (request) => {
      refuseSimulatedInProduction(request.query.adapter);
      const { rows } = await deps.pool.query<{
        id: string;
        supplier_device_id: string;
        adapter: 'simulated' | 'supplier_tcp';
        is_simulated: boolean;
        code: string | null;
        last_lat: number | null;
        last_lng: number | null;
        battery_percent: number | null;
        metadata: { simulation?: unknown };
      }>(
        `select d.id, d.supplier_device_id, d.adapter::text as adapter, d.is_simulated, s.code, s.last_lat, s.last_lng,
                s.battery_percent, d.metadata
         from devices d
         left join device_assignments a on a.device_id = d.id and a.unassigned_at is null
         left join scooters s on s.id = a.scooter_id
         where d.adapter = $1 order by d.supplier_device_id`,
        [request.query.adapter],
      );
      return rows.map((r) => ({
        id: r.id,
        supplierDeviceId: r.supplier_device_id,
        adapter: r.adapter,
        isSimulated: r.is_simulated,
        scooterCode: r.code,
        lastLat: r.last_lat,
        lastLng: r.last_lng,
        batteryPercent: r.battery_percent,
        simulation: r.metadata?.simulation,
      }));
    },
  );

  app.get(
    '/internal/v1/commands/pending',
    {
      schema: {
        querystring: AdapterQuery,
        response: { 200: z.array(InternalPendingCommandSchema) },
      },
    },
    async (request) => {
      refuseSimulatedInProduction(request.query.adapter);
      const rows = await fetchPendingCommands(deps.pool, request.query.adapter, deps.now());
      return rows.map((r) => ({
        id: r.id,
        supplierDeviceId: r.supplier_device_id,
        type: r.type,
        deadlineAt: r.deadline_at.toISOString(),
      }));
    },
  );

  app.post(
    '/internal/v1/commands/:id/result',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: InternalCommandResultSchema,
        response: { 200: InternalCommandResultResponseSchema },
      },
    },
    async (request) => {
      const result = await recordCommandResult(deps, request.params.id, request.body);
      if (!result) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
      if (result.late)
        request.log.warn({ commandId: request.params.id }, 'late device acknowledgment');
      return { accepted: true as const, late: result.late, duplicate: result.duplicate };
    },
  );

  app.post(
    '/internal/v1/telemetry',
    {
      // Telemetry batches can be larger than user requests but stay bounded.
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        body: InternalTelemetryBatchSchema,
        response: { 200: z.object({ results: z.array(z.string()) }) },
      },
    },
    async (request) => {
      const results: string[] = [];
      for (const report of request.body.reports) results.push(await ingestTelemetry(deps, report));
      return { results };
    },
  );
};
