import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  timeInPath,
  coursetimePaths,
  coursetimeFirst,
  interpolateTrack,
  calculateCourseTime,
  type TrackPoint,
  type CoursePolygon,
} from '../src/course-time';

// Simple triangle
const triangle: Array<{ lat: number; lon: number }> = [
  { lat: 0, lon: 0 },
  { lat: 1, lon: 0 },
  { lat: 0.5, lon: 1 },
];

describe('pointInPolygon', () => {
  it('returns true for point inside triangle', () => {
    expect(pointInPolygon(0.5, 0.3, triangle)).toBe(true);
  });

  it('returns false for point outside triangle', () => {
    expect(pointInPolygon(1.5, 1.5, triangle)).toBe(false);
  });

  it('returns false for empty polygon', () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
  });
});

describe('interpolateTrack', () => {
  it('resamples track to 100ms intervals', () => {
    const track: TrackPoint[] = [
      { lat: 0, lon: 0, time: 0 },
      { lat: 0.001, lon: 0.001, time: 1 },
    ];
    const out = interpolateTrack(track, 100);
    expect(out.length).toBeGreaterThan(2);
    expect(out[0].time).toBe(0);
    expect(out[out.length - 1].time).toBe(1);
  });

  it('returns single point unchanged', () => {
    const track: TrackPoint[] = [{ lat: 0, lon: 0, time: 0 }];
    expect(interpolateTrack(track)).toEqual(track);
  });
});

describe('timeInPath', () => {
  const poly: CoursePolygon = { name: 'Gate', order: 0, points: triangle };

  it('finds exit times when track crosses polygon', () => {
    const track: TrackPoint[] = [
      { lat: -0.5, lon: 0.5, time: 0 },
      { lat: 0.5, lon: 0.3, time: 1 },
      { lat: 1.5, lon: 0.5, time: 2 },
    ];
    const { times } = timeInPath(track, poly, 'max', false);
    expect(times.length).toBe(1);
    expect(times[0]).toBe(1);
  });

  it('throws when track never enters polygon', () => {
    const track: TrackPoint[] = [
      { lat: -0.5, lon: -0.5, time: 0 },
      { lat: -0.3, lon: -0.3, time: 1 },
    ];
    expect(() => timeInPath(track, poly, 'max', false)).toThrow("Track doesn't go through path");
  });
});

describe('calculateCourseTime', () => {
  const haversine = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  const course = {
    id: '66',
    polygons: [
      { name: 'Start', order: 0, points: triangle },
      { name: 'Finish', order: 1, points: [{ lat: 2, lon: 0 }, { lat: 3, lon: 0 }, { lat: 2.5, lon: 1 }] },
    ],
    distance_m: 5000,
  };

  it('returns invalid when track too short', () => {
    const track: TrackPoint[] = [{ lat: 0.5, lon: 0.3, time: 0 }];
    const r = calculateCourseTime(course, track, haversine);
    expect(r.valid).toBe(false);
  });

  it('returns invalid when track does not pass gates', () => {
    const track: TrackPoint[] = [
      { lat: 0.5, lon: 0.3, time: 0 },
      { lat: 0.6, lon: 0.4, time: 1 },
    ];
    const r = calculateCourseTime(course, track, haversine);
    expect(r.valid).toBe(false);
  });

  it('returns valid when track passes start and finish', () => {
    // Track: inside Start -> exit Start -> ... -> enter Finish -> exit Finish
    const track: TrackPoint[] = [
      { lat: 0.5, lon: 0.3, time: 0 },   // inside Start
      { lat: 0.6, lon: 0.4, time: 1 },   // inside Start
      { lat: 1.2, lon: 0.5, time: 2 },   // outside (exit Start at t=1)
      { lat: 1.5, lon: 0.5, time: 3 },   // outside
      { lat: 2.5, lon: 0.3, time: 4 },   // inside Finish
      { lat: 3.5, lon: 0.3, time: 5 },   // outside (exit Finish at t=5)
    ];
    const r = calculateCourseTime(course, track, haversine);
    expect(r.valid).toBe(true);
    expect(r.timeS).toBeGreaterThan(0);
    expect(r.distanceM).toBe(5000);
  });
});
