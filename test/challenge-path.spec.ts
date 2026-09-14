import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { storedCourseTrack, downsampleCourseSegment } from '../src/course-segment';
import * as intervals from '../src/intervals-api';
import fixture from './fixtures/foster-city-fit.json';

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('https://rownative.icu/api/' + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function cookie() {
  const raw = new Uint8Array(32);
  raw.set(new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY).slice(0, 32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify({ athleteId: 'athlete', accessToken: 'test', expiresAt: Date.now() + 100000 })));
  const bytes = new Uint8Array(12 + encrypted.byteLength);
  bytes.set(iv); bytes.set(new Uint8Array(encrypted), 12);
  return 'rn_session=' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function challenge(id = 'challenge', course = '84') {
  await env.DB!.prepare(`INSERT INTO challenges (id,name,course_id,row_start,row_end,submit_end,organizer_id,created_at)
    VALUES (?, 'Test', ?, '2020-01-01', '2099-01-01', '2099-01-01', 'athlete', '2026-01-01')`).bind(id, course).run();
}
async function result(path: string | null = '[[1,2],[3,4]]') {
  await env.DB!.prepare(`INSERT INTO challenge_results
    (id,challenge_id,athlete_id,activity_id,raw_time_s,validation_status,submitted_at,category_key,course_track_latlng,track_latlng,course_distance_m)
    VALUES ('result','challenge','athlete','activity',100,'valid','2026-01-01','1x|alice||',?,'[[90,90],[80,80]]',500)`)
    .bind(path).run();
}
beforeEach(async () => {
  await applyD1Migrations(env.DB!, env.TEST_MIGRATIONS);
  await env.ROWING_COURSES!.put('removed-challenges:list', '[]');
});
afterEach(() => vi.restoreAllMocks());

describe('public course paths', () => {
  it('serves only the opted-in segment without authentication and exposes availability separately', async () => {
    await challenge(); await result();
    const res = await request('challenges/challenge/results/result/track');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ latlng: [[1, 2], [3, 4]] });
    const listing = await request('challenges/challenge/results');
    const data = await listing.json() as { results: Record<string, unknown>[] };
    expect(data.results[0]).toMatchObject({ courseDistanceM: 500, hasCourseTrack: true });
    expect(JSON.stringify(data)).not.toContain('latlng');
  });
  it.each([null, '', '[]', 'broken'])('never falls back to organiser GPS for unavailable path %s', async (path) => {
    await challenge(); await result(path);
    const res = await request('challenges/challenge/results/result/track');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(['private', 'deleted', 'removed', 'disqualified', 'wrong-challenge'])('hides %s results', async (state) => {
    await challenge(); await result();
    if (state === 'private') await env.DB!.exec('UPDATE challenges SET is_public = 0');
    if (state === 'deleted') await env.DB!.exec('UPDATE challenges SET is_deleted = 1');
    if (state === 'removed') await env.ROWING_COURSES!.put('removed-challenges:list', '["challenge"]');
    if (state === 'disqualified') await env.DB!.exec("UPDATE challenge_results SET validation_status = 'disqualified'");
    const id = state === 'wrong-challenge' ? 'other' : 'challenge';
    expect((await request(`challenges/${id}/results/result/track`)).status).toBe(404);
  });
  it('serves manually approved shared results', async () => {
    await challenge(); await result();
    await env.DB!.exec("UPDATE challenge_results SET validation_status = 'manual_ok'");
    expect((await request('challenges/challenge/results/result/track')).status).toBe(200);
  });
});

describe('submission consent and storage', () => {
  it.each([undefined, false, 'true', 1])('does not store course coordinates for consent %s', (consent) => {
    expect(storedCourseTrack([{ lat: 1, lon: 2, time: 0 }, { lat: 2, lon: 3, time: 1 }], consent)).toBeNull();
  });
  it('caps display points while preserving both interval endpoints', () => {
    const track = Array.from({ length: 1234 }, (_, time) => ({ lat: time / 100, lon: 2, time }));
    const path = downsampleCourseSegment(track);
    expect(path).toHaveLength(600);
    expect(path[0]).toEqual([0, 2]);
    expect(path.at(-1)).toEqual([12.33, 2]);
  });
  it('persists actual distance and removes a previously shared segment on unchecked resubmission', async () => {
    await challenge();
    const session = fixture.sessions[0];
    vi.spyOn(intervals, 'fetchIntervalsActivity').mockResolvedValue({ id: 'activity', start_date_local: '2026-09-05T08:00:00' });
    vi.spyOn(intervals, 'fetchIntervalsStreams').mockResolvedValue({ latlng: session.track.map(p => [p.lat, p.lon]), time: session.track.map(p => p.time) });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(fixture.course));
    const headers = { Cookie: await cookie(), 'Content-Type': 'application/json' };
    for (const consent of [undefined, true, false]) {
      const res = await request('challenges/challenge/submit', { method: 'POST', headers,
        body: JSON.stringify({ activityId: 'activity', displayName: 'Alice', boatType: '1x', shareCoursePath: consent }) });
      expect(res.status, await res.clone().text()).toBe(200);
      const row = await env.DB!.prepare('SELECT * FROM challenge_results').first();
      expect(row!.course_distance_m).toBeGreaterThan(4000);
      expect(row!.course_distance_m).toBeLessThan(6000);
      expect(row!.track_latlng).toBeTruthy();
      expect(row!.course_track_latlng != null).toBe(consent === true);
      if (consent === true) expect(JSON.parse(String(row!.course_track_latlng)).length).toBeLessThanOrEqual(600);
    }
    expect((await env.DB!.prepare('SELECT COUNT(*) AS n FROM challenge_results').first())!.n).toBe(1);
  });

  it('returns gate diagnostics and the GPS trace when a submitted result misses gates', async () => {
    await challenge();
    const session = fixture.sessions.find(s => s.file === '9-5-26-HOTD.fit')!;
    vi.spyOn(intervals, 'fetchIntervalsActivity').mockResolvedValue({ id: 'activity', start_date_local: '2026-09-05T08:00:00' });
    vi.spyOn(intervals, 'fetchIntervalsStreams').mockResolvedValue({ latlng: session.track.map(p => [p.lat, p.lon]), time: session.track.map(p => p.time) });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(fixture.course));

    const res = await request('challenges/challenge/submit', {
      method: 'POST',
      headers: { Cookie: await cookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: 'activity', displayName: 'Alice', boatType: '1x' }),
    });
    expect(res.status, await res.clone().text()).toBe(400);
    const data = await res.json() as {
      error?: string;
      validationNote?: string;
      latlng?: unknown[];
      gateDiagnostics?: { reason?: string; gates?: Array<{ name: string; passed: boolean }> };
    };
    expect(data.error).toBe('Validation failed');
    expect(data.gateDiagnostics?.reason).toBe('missed_gates');
    expect(data.gateDiagnostics?.gates?.filter(gate => gate.passed)).toHaveLength(15);
    expect(data.gateDiagnostics?.gates?.filter(gate => !gate.passed).map(gate => gate.name)).toEqual(['Finish']);
    expect(data.latlng?.length).toBeGreaterThan(1);
    expect(data.latlng?.length).toBeLessThanOrEqual(session.track.length);
  });

  it('returns no map trace when a submitted result is not near the course', async () => {
    await challenge();
    vi.spyOn(intervals, 'fetchIntervalsActivity').mockResolvedValue({ id: 'activity', start_date_local: '2026-09-05T08:00:00' });
    vi.spyOn(intervals, 'fetchIntervalsStreams').mockResolvedValue({ latlng: [[0, 0], [0.1, 0.1]], time: [0, 1] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(fixture.course));

    const res = await request('challenges/challenge/submit', {
      method: 'POST',
      headers: { Cookie: await cookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: 'activity', displayName: 'Alice', boatType: '1x' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { latlng?: unknown[]; gateDiagnostics?: { reason?: string } };
    expect(data.gateDiagnostics?.reason).toBe('no_gates');
    expect(data.latlng).toEqual([]);
  });
});

describe('challenge merges', () => {
  it.each([['84', false], ['84', true], ['other-course', false]] as const)(
    'keeps new fields with the winning result when merging into %s (collision %s)', async (course, collision) => {
      await challenge(); await challenge('target', course); await result();
      if (collision) {
        await env.DB!.prepare(`INSERT INTO challenge_results (id,challenge_id,athlete_id,activity_id,raw_time_s,validation_status,submitted_at,category_key,course_distance_m)
          VALUES ('target-result','target','athlete','slower',200,'valid','2026-01-01','1x|alice||',900)`).run();
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
      const res = await request('organiser/challenges/challenge?mergeInto=target', { method: 'DELETE', headers: { Cookie: await cookie() } });
      expect(res.status, await res.clone().text()).toBe(200);
      const row = await env.DB!.prepare("SELECT * FROM challenge_results WHERE challenge_id='target'").first();
      expect(row!.raw_time_s).toBe(100);
      expect(row!.course_distance_m).toBe(course === '84' ? 500 : null);
      expect(row!.course_track_latlng != null).toBe(course === '84');
    });
});
