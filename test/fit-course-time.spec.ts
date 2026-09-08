import { describe, expect, it } from 'vitest';
import { calculateCourseTime } from '../src/course-time';
import fixture from './fixtures/foster-city-fit.json';

// Course 84 supplies the measured distance; this function is only used for
// intermediate GPS distance bookkeeping, which does not determine gate passage.
const distance = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
};

describe('Foster City Lagoon real FIT recordings', () => {
  it.each([
    ['20049273969_5152_m_Row.fit', 1265.1],
    ['SpdCoach-20260905-0659AM.fit', 1265.8],
  ] as const)('%s completes the course', (file, expectedSeconds) => {
    const session = fixture.sessions.find(s => s.file === file)!;
    const result = calculateCourseTime(fixture.course, session.track, distance);
    expect(result.valid).toBe(true);
    expect(result.timeS).toBeCloseTo(expectedSeconds, 1);
    expect(result.distanceM).toBe(5100);
    expect(result.gateDiagnostics).toBeUndefined();
  });

  it('HOTD misses only the finish and qualifies for the diagnostic map', () => {
    const session = fixture.sessions.find(s => s.file === '9-5-26-HOTD.fit')!;
    const result = calculateCourseTime(fixture.course, session.track, distance);
    expect(result.valid).toBe(false);
    expect(result.gateDiagnostics?.reason).toBe('missed_gates');
    expect(result.gateDiagnostics?.gates.filter(g => g.passed)).toHaveLength(15);
    expect(result.gateDiagnostics?.gates.filter(g => !g.passed).map(g => g.name)).toEqual(['Finish']);
  });
});
