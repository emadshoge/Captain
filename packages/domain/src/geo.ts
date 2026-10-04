/**
 * Geometry for zones and nearby search. Coordinates follow GeoJSON order:
 * [longitude, latitude] (WGS84). GPS is not proof of physical position;
 * results feed policy decisions, never automatic hardware actions.
 */
export type Position = [lng: number, lat: number];
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}
export type ZoneGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface LatLng {
  lat: number;
  lng: number;
}

export const MAX_ZONE_VERTICES = 2_000;

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    // (0,0) "null island" is almost always a GPS fix failure.
    !(lat === 0 && lng === 0)
  );
}

/** Great-circle distance in metres (haversine, mean Earth radius). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting; points exactly on an edge may fall either side. */
function inRing(point: LatLng, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygon(point: LatLng, rings: Position[][]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(point, outer)) return false;
  return !holes.some((hole) => inRing(point, hole));
}

export function pointInGeometry(point: LatLng, geometry: ZoneGeometry): boolean {
  return geometry.type === 'Polygon'
    ? inPolygon(point, geometry.coordinates)
    : geometry.coordinates.some((polygon) => inPolygon(point, polygon));
}

export interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export function boundingBox(geometry: ZoneGeometry): BoundingBox {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  const points = rings.flat();
  return {
    minLat: Math.min(...points.map((p) => p[1])),
    minLng: Math.min(...points.map((p) => p[0])),
    maxLat: Math.max(...points.map((p) => p[1])),
    maxLng: Math.max(...points.map((p) => p[0])),
  };
}

/**
 * Validates a GeoJSON Polygon/MultiPolygon for use as a zone. Returns a list
 * of problems (empty when valid).
 */
export function validateZoneGeometry(input: unknown): string[] {
  const problems: string[] = [];
  const geometry = input as { type?: unknown; coordinates?: unknown };
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    return ['geometry.type must be Polygon or MultiPolygon'];
  }
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return ['geometry.coordinates must not be empty'];
  }
  const polygons = (
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  ) as unknown[];
  let vertices = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      problems.push('each polygon needs at least one ring');
      continue;
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) {
        problems.push('each ring needs at least 4 positions (closed)');
        continue;
      }
      vertices += ring.length;
      for (const position of ring) {
        if (
          !Array.isArray(position) ||
          position.length < 2 ||
          !isValidLatLng(Number(position[1]), Number(position[0]))
        ) {
          problems.push('positions must be [lng, lat] within valid ranges');
          break;
        }
      }
      const first = ring[0] as number[];
      const last = ring[ring.length - 1] as number[];
      if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1])
        problems.push('rings must be closed (first = last)');
    }
  }
  if (vertices > MAX_ZONE_VERTICES) problems.push(`at most ${MAX_ZONE_VERTICES} vertices`);
  return [...new Set(problems)];
}
