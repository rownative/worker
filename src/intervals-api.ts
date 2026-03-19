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
  return (await res.json()) as IntervalsStreams;
}

/** OTW rowing only. Exclude indoor/erg (RowingIndoor, etc). */
export function isOtwRowing(activity: IntervalsActivity): boolean {
  const t = (activity.type ?? '').trim();
  return t === 'Rowing';
}
