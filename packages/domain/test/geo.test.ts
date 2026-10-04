import { describe, expect, it } from 'vitest';
import {
  boundingBox,
  distanceMeters,
  isValidLatLng,
  pointInGeometry,
  validateZoneGeometry,
  type ZoneGeometry,
} from '../src';

const square: ZoneGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [38.7, 9.0],
      [38.8, 9.0],
      [38.8, 9.1],
      [38.7, 9.1],
      [38.7, 9.0],
    ],
    // hole in the middle
    [
      [38.74, 9.04],
      [38.76, 9.04],
      [38.76, 9.06],
      [38.74, 9.06],
      [38.74, 9.04],
    ],
  ],
};

describe('pointInGeometry', () => {
  it('handles inside, outside and holes', () => {
    expect(pointInGeometry({ lat: 9.02, lng: 38.72 }, square)).toBe(true);
    expect(pointInGeometry({ lat: 9.05, lng: 38.75 }, square)).toBe(false); // in hole
    expect(pointInGeometry({ lat: 9.2, lng: 38.75 }, square)).toBe(false);
  });

  it('handles concave polygons and multipolygons', () => {
    const lShape: ZoneGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0.1, 0.1],
          [2, 0.1],
          [2, 1],
          [1, 1],
          [1, 2],
          [0.1, 2],
          [0.1, 0.1],
        ],
      ],
    };
    expect(pointInGeometry({ lat: 1.5, lng: 0.5 }, lShape)).toBe(true);
    expect(pointInGeometry({ lat: 1.5, lng: 1.5 }, lShape)).toBe(false); // the notch
    const multi: ZoneGeometry = {
      type: 'MultiPolygon',
      coordinates: [square.coordinates, lShape.coordinates],
    };
    expect(pointInGeometry({ lat: 0.5, lng: 0.5 }, multi)).toBe(true);
  });
});

describe('distanceMeters', () => {
  it('matches known distances within 0.5%', () => {
    // Meskel Square -> Bole International Airport (approx. 5.9 km great-circle)
    const d = distanceMeters({ lat: 9.0108, lng: 38.7613 }, { lat: 8.9779, lng: 38.7993 });
    expect(d).toBeGreaterThan(5_500);
    expect(d).toBeLessThan(5_700);
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111_195, -2);
  });
});

describe('validation', () => {
  it('accepts a valid polygon and computes its bounding box', () => {
    expect(validateZoneGeometry(square)).toEqual([]);
    expect(boundingBox(square)).toEqual({ minLat: 9.0, minLng: 38.7, maxLat: 9.1, maxLng: 38.8 });
  });

  it.each([
    [{ type: 'Point', coordinates: [1, 2] }, /Polygon or MultiPolygon/],
    [{ type: 'Polygon', coordinates: [] }, /must not be empty/],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [1, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
      /at least 4/,
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 2],
          ],
        ],
      },
      /closed/,
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [1, 1],
            [200, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
      /valid ranges/,
    ],
    [null, /Polygon or MultiPolygon/],
  ])('rejects %j', (geometry, message) => {
    expect(validateZoneGeometry(geometry).join(';')).toMatch(message);
  });

  it('rejects null island and out-of-range coordinates', () => {
    expect(isValidLatLng(0, 0)).toBe(false);
    expect(isValidLatLng(91, 10)).toBe(false);
    expect(isValidLatLng(Number.NaN, 10)).toBe(false);
    expect(isValidLatLng(9.01, 38.76)).toBe(true);
  });
});
