import {
  NearbyQuerySchema,
  RiderScooterSchema,
  ScooterLookupQuerySchema,
  ScooterLookupSchema,
  ZoneSchema,
  ZonesQuerySchema,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRider } from '../auth/http';
import type { AuthDeps } from '../auth/service';
import { nearbyScooters, requireScooter, unavailableReason, type ZoneRow } from './service';

export const riderFleetRoutes: FastifyPluginAsyncZod<{ deps: AuthDeps }> = async (
  app,
  { deps },
) => {
  app.addHook('onRequest', requireRider(deps));

  app.get(
    '/v1/rider/scooters/nearby',
    { schema: { querystring: NearbyQuerySchema, response: { 200: z.array(RiderScooterSchema) } } },
    async (request) => {
      const { lat, lng, radiusM, limit } = request.query;
      return nearbyScooters(deps, { lat, lng }, radiusM, limit);
    },
  );

  /** QR scan or manual code entry. Unknown codes return 404 SCOOTER_NOT_FOUND. */
  app.get(
    '/v1/rider/scooters/lookup',
    { schema: { querystring: ScooterLookupQuerySchema, response: { 200: ScooterLookupSchema } } },
    async (request) => {
      const row = await requireScooter(deps.pool, request.query);
      const reason = unavailableReason(row, deps.config, deps.now());
      return {
        code: row.code,
        model: row.model,
        available: reason === null,
        unavailableReason: reason,
        batteryPercent: row.battery_percent,
        lastUpdateAt: row.last_telemetry_at?.toISOString() ?? null,
      };
    },
  );

  app.get(
    '/v1/rider/zones',
    { schema: { querystring: ZonesQuerySchema, response: { 200: z.array(ZoneSchema) } } },
    async (request) => {
      const { minLat, minLng, maxLat, maxLng } = request.query;
      const { rows } = await deps.pool.query<ZoneRow>(
        `select id, name, kind::text as kind, geometry, active, version, is_dev_fixture from zones
         where active and max_lat >= $1 and min_lat <= $3 and max_lng >= $2 and min_lng <= $4
         order by kind, name limit 500`,
        [minLat, minLng, maxLat, maxLng],
      );
      return rows.map(toZone);
    },
  );
};

export function toZone(row: ZoneRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    geometry: row.geometry as z.infer<typeof ZoneSchema>['geometry'],
    active: row.active,
    version: row.version,
    isDevFixture: row.is_dev_fixture,
  };
}
