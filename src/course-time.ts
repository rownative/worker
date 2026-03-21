/**
 * Course time calculation — port of Rowsandall handle_check_race_course / courseutils.
 * Computes net time on a measured course from GPS track by detecting polygon gate passages.
 */

export interface TrackPoint {
  lat: number;
  lon: number;
  time: number;
}

export interface CoursePolygon {
  name: string;
  order: number;
  points: Array<{ lat: number; lon: number }>;
}

export interface Course {
  id: string;
  polygons: CoursePolygon[];
  distance_m?: number;
}

export interface CourseTimeResult {
  valid: boolean;
  timeS: number;
  distanceM: number;
  validationNote: string;
  startSecond?: number;
  endSecond?: number;
  _debug?: {
    exitTimesFromStart: number[];
    records: Array<{ netTime: number; startS: number; endS: number; completed: boolean }>;
    best: { netTime: number; startS: number; endS: number };
  };
}

/** Ray-casting point-in-polygon. Polygon should be closed (implicit if first !== last). */
export function pointInPolygon(
  lat: number,
  lon: number,
  polygon: Array<{ lat: number; lon: number }>
): boolean {
  if (polygon.length < 3) return false;
  const n = polygon.length;
  let inside = false;
  const x = lon;
  const y = lat;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Build closed path from polygon points (append first point if not closed). */
function polygonToPath(polygon: CoursePolygon): Array<{ lat: number; lon: number }> {
  const pts = polygon.points;
  if (pts.length < 3) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lon - last.lon) < 1e-9) {
    return pts;
  }
  return [...pts, first];
}

export class InvalidTrajectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTrajectoryError';
  }
}

type MaxMin = 'max' | 'min';

/**
 * Find times when track crosses polygon boundary.
 * maxmin='max' → exit (inside → outside). maxmin='min' → entry (outside → inside).
 * getall=true → return all such times; else first only.
 */
export function timeInPath(
  track: TrackPoint[],
  polygon: CoursePolygon,
  maxmin: MaxMin = 'max',
  getall = false
): { times: number[]; distances?: number[] } {
  if (track.length === 0) throw new InvalidTrajectoryError('Track empty');
  const path = polygonToPath(polygon);
  const inPolygon = track.map((p) => pointInPolygon(p.lat, p.lon, path));

  const transitions: number[] = [];
  const dists: number[] = [];

  for (let i = 0; i < track.length - 1; i++) {
    const currInside = inPolygon[i];
    const nextInside = inPolygon[i + 1];
    if (maxmin === 'max') {
      if (currInside && !nextInside) {
        transitions.push(track[i].time);
        dists.push((track[i] as TrackPoint & { cumdist?: number }).cumdist ?? 0);
      }
    } else {
      if (!currInside && nextInside) {
        transitions.push(track[i + 1].time);
        dists.push((track[i + 1] as TrackPoint & { cumdist?: number }).cumdist ?? 0);
      }
    }
  }

  if (transitions.length === 0) throw new InvalidTrajectoryError("Track doesn't go through path");
  if (getall) return { times: transitions, distances: dists.length ? dists : undefined };
  return { times: [Math.min(...transitions)], distances: dists.length ? [Math.min(...dists)] : undefined };
}

/**
 * Recursive: find first complete passage through gates in order.
 * Returns (endTime, distance, completed). For last gate uses exit time.
 */
export function coursetimePaths(
  track: TrackPoint[],
  polygons: CoursePolygon[],
  finalMaxMin: MaxMin = 'min',
  log: string[] = []
): { time: number; dist: number; completed: boolean } {
  if (polygons.length === 0) return { time: track[0]?.time ?? 0, dist: 0, completed: true };
  if (polygons.length === 1) {
    try {
      const { times } = timeInPath(track, polygons[0], finalMaxMin, false);
      return {
        time: times[0],
        dist: 0,
        completed: true,
      };
    } catch {
      return {
        time: track[track.length - 1]?.time ?? 0,
        dist: 0,
        completed: false,
      };
    }
  }

  try {
    const { times } = timeInPath(track, polygons[0], 'max', false);
    const t0 = times[0];
    const slice = track.filter((p) => p.time > t0).map((p) => ({
      ...p,
      time: p.time - t0,
    }));
    const rest = coursetimePaths(slice, polygons.slice(1), finalMaxMin, log);
    return {
      time: t0 + rest.time,
      dist: rest.dist,
      completed: rest.completed,
    };
  } catch {
    return {
      time: track[track.length - 1]?.time ?? 0,
      dist: 0,
      completed: false,
    };
  }
}

/**
 * First exit through start polygon.
 */
export function coursetimeFirst(
  track: TrackPoint[],
  polygons: CoursePolygon[]
): { time: number; dist: number; completed: boolean } {
  if (polygons.length === 0) return { time: track[0]?.time ?? 0, dist: 0, completed: false };
  try {
    const { times } = timeInPath(track, polygons[0], 'max', false);
    return { time: times[0], dist: 0, completed: true };
  } catch {
    return {
      time: track[track.length - 1]?.time ?? 0,
      dist: 0,
      completed: false,
    };
  }
}

/**
 * Linear interpolation to 100ms resolution. Critical for narrow gate detection.
 */
export function interpolateTrack(
  points: TrackPoint[],
  intervalMs = 100
): TrackPoint[] {
  if (points.length < 2) return points;
  const result: TrackPoint[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dtMs = (b.time - a.time) * 1000;
    const steps = Math.max(1, Math.ceil(dtMs / intervalMs));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      result.push({
        lat: a.lat + t * (b.lat - a.lat),
        lon: a.lon + t * (b.lon - a.lon),
        time: a.time + t * (b.time - a.time),
      });
    }
    result.push(b);
  }
  return result;
}

/** Compute cumulative distance along track (meters) using haversine. */
function addCumulativeDistance(
  points: TrackPoint[],
  haversine: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number
): Array<TrackPoint & { cumdist: number }> {
  const out: Array<TrackPoint & { cumdist: number }> = [];
  let cum = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) cum += haversine(points[i - 1], points[i]);
    out.push({ ...points[i], cumdist: cum });
  }
  return out;
}

/**
 * Main entry: compute best course time from track.
 */
export function calculateCourseTime(
  course: Course,
  track: TrackPoint[],
  haversineFn: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number,
  options?: { log?: string[]; debug?: boolean }
): CourseTimeResult {
  const log = options?.log ?? [];
  const note: string[] = [];

  if (track.length < 2) {
    return { valid: false, timeS: 0, distanceM: 0, validationNote: 'Track too short' };
  }
  if (course.polygons.length < 2) {
    return { valid: false, timeS: 0, distanceM: 0, validationNote: 'Course has fewer than 2 gates' };
  }

  const interpolated = interpolateTrack(track);
  const withDist = addCumulativeDistance(interpolated, haversineFn);
  const paths = course.polygons.map((p) => polygonToPath(p));

  let entryTimes: number[];
  try {
    const r = timeInPath(withDist, course.polygons[0], 'max', true);
    entryTimes = r.times;
    note.push(`Course id ${course.id}, Found ${entryTimes.length} exit times from start`);
  } catch {
    note.push(`Course id ${course.id}, Track does not pass through start gate`);
    return { valid: false, timeS: 0, distanceM: 0, validationNote: note.join('\n') };
  }

  const records: Array<{ netTime: number; dist: number; completed: boolean; startS: number; endS: number }> = [];

  for (const startT of entryTimes) {
    const sliceStart = Math.max(0, startT - 10);
    const sliced = withDist.filter((p) => p.time >= sliceStart).map((p) => ({
      ...p,
      time: p.time - sliceStart,
    }));
    const polygons = course.polygons;
    const pathsResult = coursetimePaths(sliced, polygons, 'max', log);
    const endS = pathsResult.time + sliceStart;
    const netTime = endS - startT;
    const dist = pathsResult.time > 0 ? (pathsResult.dist || 0) : 0;
    records.push({
      netTime,
      dist,
      completed: pathsResult.completed,
      startS: startT,
      endS,
    });
    note.push(
      `Path starting at ${startT.toFixed(1)}s: completed=${pathsResult.completed}, net=${netTime.toFixed(1)}s`
    );
  }

  const completed = records.filter((r) => r.completed);
  if (completed.length === 0) {
    return { valid: false, timeS: 0, distanceM: 0, validationNote: note.join('\n') };
  }

  const best = completed.reduce((a, b) => (a.netTime < b.netTime ? a : b));
  const distanceM = course.distance_m ?? best.dist;

  const debugPayload = options?.debug
    ? {
        exitTimesFromStart: entryTimes,
        records: records.map((r) => ({ netTime: r.netTime, startS: r.startS, endS: r.endS, completed: r.completed })),
        best: { netTime: best.netTime, startS: best.startS, endS: best.endS },
      }
    : undefined;

  // #region agent log
  try {
    const logBody = JSON.stringify({
      sessionId: 'e1b1a2',
      location: 'course-time.ts:calculateCourseTime',
      message: 'Gate crossings and net time',
      data: {
        courseId: course.id,
        exitTimesFromStart: entryTimes,
        records: records.map((r) => ({ netTime: r.netTime, startS: r.startS, endS: r.endS, completed: r.completed })),
        best: { netTime: best.netTime, startS: best.startS, endS: best.endS },
      },
      timestamp: Date.now(),
      hypothesisId: 'H3,H4',
    });
    fetch('http://127.0.0.1:7691/ingest/770bd333-f0c6-4569-b816-3db8bb63447a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e1b1a2' },
      body: logBody,
    }).catch(() => {});
  } catch (_) {}
  // #endregion

  return {
    valid: true,
    timeS: best.netTime,
    distanceM,
    validationNote: note.join('\n'),
    startSecond: best.startS,
    endSecond: best.endS,
    ...(debugPayload && { _debug: debugPayload }),
  };
}
