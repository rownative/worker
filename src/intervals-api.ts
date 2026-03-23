/**
 * intervals.icu API helpers for Phase 2 — activities and streams.
 * Requires OAuth access token (from session cookie).
 */

const INTERVALS_BASE = 'https://intervals.icu';

export interface IntervalsActivity {
  id: string;
  name?: string;
  type?: string;
  start_date_local?: string;
  distance?: number;
  moving_time?: number;
  stream_types?: string[];
}

export interface IntervalsStreams {
  latlng?: [number, number][];
  time?: number[];
}

/**
 * Fetch activities for date range. Filter to OTW rowing (type === 'Rowing') in caller.
 */
export async function fetchIntervalsActivities(
  athleteId: string,
  accessToken: string,
  oldest: string,
  newest: string
): Promise<IntervalsActivity[]> {
  const url = `${INTERVALS_BASE}/api/v1/athlete/${athleteId}/activities?oldest=${oldest}&newest=${newest}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`intervals.icu activities: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Parse intervals.icu streams response into { latlng, time }.
 * Intervals.icu returns latlng as { data: lat[], data2: lon[] } (separate arrays).
 * Response may be { latlng: {...}, time: {...} } or [{ type, data, data2 }, ...].
 */
function parseStreamsResponse(raw: unknown): IntervalsStreams {
  const out: IntervalsStreams = {};
  if (!raw || typeof raw !== 'object') return out;

  // Format: array of stream objects [{ type: "latlng", data: [], data2: [] }, ...]
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (s && typeof s === 'object' && (s as Record<string, unknown>).type === 'latlng') {
        const stream = s as { data?: number[]; data2?: number[] };
        if (Array.isArray(stream.data) && Array.isArray(stream.data2) && stream.data.length >= 2) {
          const len = Math.min(stream.data.length, stream.data2.length);
          out.latlng = Array.from({ length: len }, (_, i) => [stream.data![i], stream.data2![i]] as [number, number]);
          break;
        }
      }
    }
    for (const s of raw) {
      if (s && typeof s === 'object' && (s as Record<string, unknown>).type === 'time') {
        const stream = s as { data?: number[] };
        if (Array.isArray(stream.data)) {
          out.time = stream.data;
          break;
        }
      }
    }
    return out;
  }

  const obj = raw as Record<string, unknown>;
  // Format: { latlng: { data: [...], data2: [...] }, time: { data: [...] } }
  const latlngStream = obj.latlng as { data?: number[]; data2?: number[] } | undefined;
  if (latlngStream && typeof latlngStream === 'object') {
    const data = latlngStream.data;
    const data2 = latlngStream.data2;
    if (Array.isArray(data) && Array.isArray(data2) && data.length >= 2) {
      const len = Math.min(data.length, data2.length);
      out.latlng = Array.from({ length: len }, (_, i) => [data[i], data2[i]] as [number, number]);
    }
  }
  // Format: latlng already [[lat,lon],...]
  if (!out.latlng && Array.isArray(obj.latlng) && obj.latlng.length >= 2) {
    out.latlng = obj.latlng as [number, number][];
  }
  // Time stream
  const timeStream = obj.time as { data?: number[] } | undefined;
  if (timeStream && typeof timeStream === 'object' && Array.isArray(timeStream.data)) {
    out.time = timeStream.data;
  }
  if (!out.time && Array.isArray(obj.time)) {
    out.time = obj.time as number[];
  }
  return out;
}

/**
 * Fetch a single activity by ID (for start_date_local).
 */
export async function fetchIntervalsActivity(
  activityId: string,
  accessToken: string
): Promise<IntervalsActivity | null> {
  const url = `${INTERVALS_BASE}/api/v1/activity/${activityId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data as IntervalsActivity;
}

/**
 * Fetch GPS + time streams for an activity.
 */
export async function fetchIntervalsStreams(
  activityId: string,
  accessToken: string
): Promise<IntervalsStreams> {
  const url = `${INTERVALS_BASE}/api/v1/activity/${activityId}/streams.json?types=latlng,time`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`intervals.icu streams: ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  return parseStreamsResponse(raw);
}

/** OTW rowing only. Exclude indoor/erg (RowingIndoor, etc). */
export function isOtwRowing(activity: IntervalsActivity): boolean {
  const t = (activity.type ?? '').trim();
  return t === 'Rowing';
}

/** Athlete profile for display name pre-fill. */
export interface IntervalsAthleteProfile {
  id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Fetch athlete profile from intervals.icu (for display name in challenge submission).
 * Requires OAuth access token. Returns null on failure.
 */
export async function fetchIntervalsAthleteProfile(
  accessToken: string
): Promise<IntervalsAthleteProfile | null> {
  const res = await fetch(`${INTERVALS_BASE}/api/v1/athlete/self`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as Record<string, unknown>;
  if (!data || typeof data.id !== 'string') return null;
  const name =
    typeof data.name === 'string' && data.name.trim()
      ? data.name.trim()
      : [data.first_name, data.last_name].filter(Boolean).join(' ').trim() || undefined;
  return {
    id: data.id as string,
    name,
    first_name: typeof data.first_name === 'string' ? data.first_name : undefined,
    last_name: typeof data.last_name === 'string' ? data.last_name : undefined,
  };
}
