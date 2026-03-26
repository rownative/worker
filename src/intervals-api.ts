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
export function parseStreamsResponse(raw: unknown): IntervalsStreams {
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

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Merge nested objects intervals.icu sometimes returns on athlete/self. */
function flattenAthleteJson(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const nested = d.athlete;
  if (nested && typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return { ...d, ...(nested as Record<string, unknown>) };
  }
  return d;
}

function athleteIdFromPayload(flat: Record<string, unknown>): string | null {
  const rawId = flat.id;
  if (rawId == null) return null;
  if (typeof rawId === 'string' && rawId.trim()) return rawId.trim();
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return String(rawId);
  return null;
}

/** Build display name from intervals.icu athlete/self payload (field names vary by API version). */
export function displayNameFromAthletePayload(data: Record<string, unknown>): string | undefined {
  const direct = pickString(data, ['name', 'displayName', 'username', 'nickname', 'fullname', 'fullName']);
  if (direct) return direct;
  const first = pickString(data, ['first_name', 'firstName', 'givenName']);
  const last = pickString(data, ['last_name', 'lastName', 'familyName']);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || undefined;
}

/**
 * Metadata from GET /api/v1/athlete/{id} (for debug=1 troubleshooting).
 * OAuth: /self is wrong; concrete id may still 403 — intervals.icu accepts id `0` as the authenticated user (see API docs / forum).
 */
export interface IntervalsAthleteSelfMeta {
  httpStatus: number;
  ok: boolean;
  topLevelKeys: string[];
  usedNestedAthlete: boolean;
  parseError?: string;
  /** True when GET /athlete/{id} failed and GET /athlete/0 returned this response. */
  usedAthlete0Fallback?: boolean;
}

function shouldRetryAthleteProfileWithZero(status: number): boolean {
  return status === 403 || status === 401 || status === 404;
}

/**
 * Same as fetchIntervalsAthleteProfile plus response metadata (one or two HTTP requests).
 * @param athleteId intervals.icu athlete id (e.g. i58453). If GET /athlete/{id} is forbidden for OAuth, retries GET /athlete/0 (authenticated user alias per intervals.icu API).
 */
export async function fetchIntervalsAthleteProfileWithMeta(
  accessToken: string,
  athleteId: string
): Promise<{ profile: IntervalsAthleteProfile | null; meta: IntervalsAthleteSelfMeta }> {
  const id = String(athleteId || '').trim();
  if (!id) {
    const meta: IntervalsAthleteSelfMeta = {
      httpStatus: 0,
      ok: false,
      topLevelKeys: [],
      usedNestedAthlete: false,
      parseError: 'missing athleteId',
    };
    return { profile: null, meta };
  }

  const paths =
    id === '0'
      ? [`/api/v1/athlete/0`]
      : [`/api/v1/athlete/${encodeURIComponent(id)}`, `/api/v1/athlete/0`];

  let lastMeta: IntervalsAthleteSelfMeta | null = null;

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const res = await fetch(`${INTERVALS_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    let raw: unknown;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch (e) {
      const meta: IntervalsAthleteSelfMeta = {
        httpStatus: res.status,
        ok: res.ok,
        topLevelKeys: [],
        usedNestedAthlete: false,
        parseError: e instanceof Error ? e.message : 'json parse error',
      };
      lastMeta = meta;
      const canRetry =
        i < paths.length - 1 && shouldRetryAthleteProfileWithZero(res.status);
      if (canRetry) continue;
      return { profile: null, meta };
    }
    const topLevelKeys =
      raw && typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? Object.keys(raw as object)
        : [];
    const usedNestedAthlete =
      !!raw &&
      typeof raw === 'object' &&
      raw !== null &&
      'athlete' in (raw as object) &&
      typeof (raw as { athlete?: unknown }).athlete === 'object' &&
      (raw as { athlete?: unknown }).athlete !== null;
    const usedAthlete0Fallback = id !== '0' && path === '/api/v1/athlete/0' && res.ok;
    const meta: IntervalsAthleteSelfMeta = {
      httpStatus: res.status,
      ok: res.ok,
      topLevelKeys,
      usedNestedAthlete,
      ...(usedAthlete0Fallback ? { usedAthlete0Fallback: true } : {}),
    };
    lastMeta = meta;

    if (!res.ok || raw == null) {
      const canRetry =
        i < paths.length - 1 && shouldRetryAthleteProfileWithZero(res.status);
      if (canRetry) continue;
      return { profile: null, meta };
    }

    const data = flattenAthleteJson(raw);
    if (!data) {
      return { profile: null, meta };
    }
    const profileId = athleteIdFromPayload(data);
    if (!profileId) {
      return { profile: null, meta };
    }
    const name = displayNameFromAthletePayload(data);
    const first_name = pickString(data, ['first_name', 'firstName', 'givenName']);
    const last_name = pickString(data, ['last_name', 'lastName', 'familyName']);
    return {
      profile: {
        id: profileId,
        name,
        first_name,
        last_name,
      },
      meta,
    };
  }

  return {
    profile: null,
    meta:
      lastMeta ?? {
        httpStatus: 0,
        ok: false,
        topLevelKeys: [],
        usedNestedAthlete: false,
      },
  };
}

/**
 * Fetch athlete profile from intervals.icu (for display name in challenge submission).
 * Requires OAuth access token and athlete id (same path segment as /athlete/{id}/activities).
 */
export async function fetchIntervalsAthleteProfile(
  accessToken: string,
  athleteId: string
): Promise<IntervalsAthleteProfile | null> {
  const { profile } = await fetchIntervalsAthleteProfileWithMeta(accessToken, athleteId);
  return profile;
}
