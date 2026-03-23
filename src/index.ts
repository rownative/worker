import { unzipSync } from 'fflate';
import { kmlToCourse, haversine } from './kml-to-course';
import { calculateCourseTime, type TrackPoint } from './course-time';
import { computeHandicap } from './handicap';
import {
  fetchIntervalsActivities,
  fetchIntervalsActivity,
  fetchIntervalsAthleteProfile,
  fetchIntervalsStreams,
  isOtwRowing,
  type IntervalsActivity,
} from './intervals-api';
import { isNameAllowed } from './content-filter';

// Rowing courses API
const COURSES_BASE = 'https://raw.githubusercontent.com/rownative/courses/main';
const GITHUB_API = 'https://api.github.com';
const ORGANISERS_CACHE_KEY = 'organisers:list';
const ORGANISERS_CACHE_TTL = 300; // 5 minutes

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — required for credentialed POST from localhost
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') ?? '';
      const allowOrigin = origin.includes('localhost') || origin.includes('127.0.0.1') ? origin : 'https://rownative.icu';
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Course index (optional geo filter: ?lat=&lon=&radius=)
    if (path === '/api/courses/' || path === '/api/courses') {
      const latVal = url.searchParams.get('lat');
      const lonVal = url.searchParams.get('lon');
      const radiusVal = url.searchParams.get('radius');
      const lat = latVal != null ? parseFloat(latVal) : NaN;
      const lon = lonVal != null ? parseFloat(lonVal) : NaN;
      const radius = radiusVal != null ? parseFloat(radiusVal) : NaN;
      const hasGeoFilter = !Number.isNaN(lat) && !Number.isNaN(lon) && !Number.isNaN(radius) && radius > 0;

      const res = await fetch(`${COURSES_BASE}/courses/index.json`);
      if (!res.ok) return new Response('Not found', { status: 404 });
      const data = (await res.json()) as Array<{ id: string; center_lat?: number; center_lon?: number; [k: string]: unknown }>;
      const courses = Array.isArray(data) ? data : [];

      const filtered = hasGeoFilter
        ? courses.filter((c) => {
            const clat = c.center_lat;
            const clon = c.center_lon;
            if (clat == null || clon == null) return false;
            return haversine({ lat, lon }, { lat: clat, lon: clon }) <= radius;
          })
        : courses;

      return new Response(JSON.stringify({ courses: filtered }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Multi-course KML bundle — must come before single course to avoid prefix match
    if (path === '/api/courses/kml/' || path === '/api/courses/kml') {
      const ids = url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [];
      if (ids.length === 0) return new Response('Missing ids parameter', { status: 400 });
      return bundleKml(ids);
    }

    // Liked courses KML bundle
    if (path === '/api/courses/kml/liked/' || path === '/api/courses/kml/liked') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return new Response('Unauthorised', { status: 401 });
      const liked: string[] = JSON.parse((await env.ROWING_COURSES.get(`liked:${athleteId}`)) ?? '[]');
      return bundleKml(liked);
    }

    // Single course KML
    const courseMatch = path.match(/^\/api\/courses\/(\d+)\/?$/);
    if (courseMatch) {
      const id = courseMatch[1];
      const cn = url.searchParams.get('cn') === 'true';
      const kmlPath = cn
        ? `${COURSES_BASE}/kml/${id}-cn.kml`
        : `${COURSES_BASE}/kml/${id}.kml`;
      return fetchFromGitHub(kmlPath, 'application/vnd.google-earth.kml+xml');
    }

    // Follow / unfollow — /api/rowers/courses/{id}/follow|unfollow
    const followMatch = path.match(/^\/api\/rowers\/courses\/(\d+)\/(follow|unfollow)\/?$/);
    if (followMatch && request.method === 'POST') {
      const id = followMatch[1];
      const action = followMatch[2];
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return new Response('Unauthorised', { status: 401 });
      const kvKey = `liked:${athleteId}`;
      const liked: string[] = JSON.parse((await env.ROWING_COURSES.get(kvKey)) ?? '[]');
      const updated = action === 'follow'
        ? [...new Set([...liked, id])]
        : liked.filter(x => x !== id);
      await env.ROWING_COURSES.put(kvKey, JSON.stringify(updated));
      return new Response(JSON.stringify({ liked: updated }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /api/me — 200 with null when unauthenticated (avoids console noise)
    if (path === '/api/me' || path === '/api/me/') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      let payload: { athleteId: string | null; liked: string[]; isOrganizer?: boolean; athleteDisplayName?: string };
      if (athleteId) {
        const session = await getSessionFromRequest(request, env);
        let athleteDisplayName: string | undefined;
        if (session?.accessToken) {
          const profile = await fetchIntervalsAthleteProfile(session.accessToken);
          athleteDisplayName = profile?.name;
        }
        const [liked, isOrg] = await Promise.all([
          env.ROWING_COURSES.get(`liked:${athleteId}`).then((v) => JSON.parse(v ?? '[]') as string[]),
          isOrganizer(athleteId, env),
        ]);
        payload = { athleteId, liked, isOrganizer: isOrg, athleteDisplayName };
      } else {
        payload = { athleteId: null, liked: [], isOrganizer: false };
      }
      const origin = request.headers.get('Origin') ?? '';
      const allowOrigin = origin.includes('localhost') || origin.includes('127.0.0.1') ? origin : 'https://rownative.icu';
      return new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }

    // POST /api/auth/crewnerd — exchange intervals.icu bearer token for API key
    if (path === '/api/auth/crewnerd' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response('Missing bearer token', { status: 401 });
      }
      const bearerToken = authHeader.slice(7);
      const athleteId = await verifyIntervalsToken(bearerToken);
      if (!athleteId) return new Response('Invalid token', { status: 401 });
      const apiKey = await apiKeyForAthlete(athleteId, env.TOKEN_ENCRYPTION_KEY);
      return new Response(JSON.stringify({ api_key: apiKey }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // OAuth debug — show exact redirect_uri for copying into intervals.icu app settings
    if (path === '/oauth/debug') {
      const localParam = url.searchParams.get('local') === '1';
      const hostHeader = request.headers.get('Host') ?? '';
      const isLocalByHost = hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1');
      const isLocalByUrl = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const isLocal = localParam || isLocalByHost || isLocalByUrl;
      const redirectUri = isLocal
        ? 'http://localhost:8787/oauth/callback'
        : 'https://rownative.icu/oauth/callback';
      return new Response(
        JSON.stringify({
          redirect_uri: redirectUri,
          hint: 'Add this exact string to intervals.icu Developer Settings → Manage App → Redirect URIs',
          request_url: url.href,
          local_param: localParam,
          host_header: hostHeader,
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // OAuth login — redirect to intervals.icu (with state for CSRF protection)
    if (path === '/oauth/authorize') {
      const localParam = url.searchParams.get('local') === '1';
      const hostHeader = request.headers.get('Host') ?? '';
      const isLocal = localParam || hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1')
        || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const redirectUri = isLocal ? 'http://localhost:8787/oauth/callback' : 'https://rownative.icu/oauth/callback';
      const state = crypto.randomUUID();
      const returnTo = url.searchParams.get('return_to');
      console.log(`[oauth] authorize: generated state=${state}, redirect_uri=${redirectUri}`);
      // Store state in KV; value 'local' or 'local:<returnTo>' signals local dev
      const stateVal = isLocal ? (returnTo ? `local:${returnTo}` : 'local') : '1';
      await env.ROWING_COURSES.put(`oauth_state:${state}`, stateVal, { expirationTtl: 600 });
      const params = new URLSearchParams({
        client_id: env.INTERVALS_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'ACTIVITY:READ',
        state,
      });
      const stateCookieSecure = isLocal ? '' : '; Secure';
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `https://intervals.icu/oauth/authorize?${params}`,
          'Set-Cookie': `rn_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${stateCookieSecure}`,
        },
      });
    }

    // OAuth callback — exchange code for tokens
    if (path === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Verify state (CSRF protection): cookie (primary) or KV (iOS fallback when cookies don't persist)
      const cookieHeader = request.headers.get('Cookie') ?? '';
      const stateMatch = cookieHeader.match(/rn_oauth_state=([^;]+)/);
      let storedState = stateMatch ? stateMatch[1].trim() : null;
      const kvVal = state ? await env.ROWING_COURSES.get(`oauth_state:${state}`) : null;
      if (!storedState && kvVal) storedState = state;
      console.log(`[oauth] callback: code present=${!!code}, state from URL=${state}`);
      console.log(`[oauth] callback: cookie header present=${cookieHeader.length > 0}, stored state=${storedState}`);
      console.log(`[oauth] callback: state match=${!!state && !!storedState && state === storedState}`);
      if (!code || !state || !storedState || state !== storedState) {
        const reason = !code ? 'Missing code' : 'Invalid state';
        console.log(`[oauth] callback: validation failed — ${reason}`);
        return new Response(reason, { status: 400 });
      }
      await env.ROWING_COURSES.delete(`oauth_state:${state}`);
      const isLocal = kvVal === 'local' || (typeof kvVal === 'string' && kvVal.startsWith('local:'));
      const returnTo = (typeof kvVal === 'string' && kvVal.startsWith('local:')) ? kvVal.slice(6) : null;

      const redirectUri = isLocal ? 'http://localhost:8787/oauth/callback' : 'https://rownative.icu/oauth/callback';

      // Exchange code for tokens
      const tokenRes = await fetch('https://intervals.icu/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.INTERVALS_CLIENT_ID,
          client_secret: env.INTERVALS_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        return new Response(`Token exchange failed: ${tokenRes.status} ${body}`, { status: 500 });
      }

      // Athlete ID is included in the token response — no separate profile call needed
      const tokens = await tokenRes.json() as {
        access_token: string;
        scope: string;
        athlete: { id: string; name: string };
      };

      const athleteId = tokens.athlete.id;

      // Encrypt session and set cookie
      // intervals.icu does not use refresh tokens or expiry — store access token only
      const session: Session = {
        athleteId,
        accessToken: tokens.access_token,
        refreshToken: '',
        expiresAt: 0, // no expiry
      };
      const cookie = await encryptSession(session, env.TOKEN_ENCRYPTION_KEY);
      const postAuthRedirect = (isLocal && returnTo) ? returnTo : (isLocal ? 'http://localhost:8080/' : '/');
      const headers = new Headers({ 'Location': postAuthRedirect });
      const cookieSecure = isLocal ? '' : '; Secure';
      headers.append('Set-Cookie', `rn_session=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000${cookieSecure}`);
      const clearStateSecure = isLocal ? '' : '; Secure';
      headers.append('Set-Cookie', `rn_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${clearStateSecure}`);

      return new Response(null, { status: 302, headers });
    }

    // OAuth logout
    if (path === '/oauth/logout') {
      const localParam = url.searchParams.get('local') === '1';
      const returnTo = url.searchParams.get('return_to');
      const hostHeader = request.headers.get('Host') ?? '';
      const isLocal = localParam || hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1')
        || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      const logoutRedirect = (isLocal && returnTo) ? returnTo : (isLocal ? 'http://localhost:8080/' : '/');
      const logoutCookieSecure = isLocal ? '' : '; Secure';
      return new Response(null, {
        status: 302,
        headers: {
          'Location': logoutRedirect,
          'Set-Cookie': `rn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${logoutCookieSecure}`,
        },
      });
    }

    // POST /api/courses/import-zip — Rowsandall ZIP import
    if (path === '/api/courses/import-zip' && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) {
        return jsonResponse({ error: 'Unauthorised' }, 401, true);
      }
      const result = await handleImportZip(request, env, athleteId);
      return result;
    }

    // POST /api/courses/submit — single KML submit (e.g. from Google Earth)
    if ((path === '/api/courses/submit' || path === '/api/courses/submit/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) {
        return jsonResponse({ error: 'Unauthorised' }, 401, true);
      }
      const result = await handleSubmitKml(request, env);
      return result;
    }

    // POST /api/courses/update — KML revision for existing provisional course
    if ((path === '/api/courses/update' || path === '/api/courses/update/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) {
        return jsonResponse({ error: 'Unauthorised' }, 401, true);
      }
      const result = await handleUpdateKml(request, env);
      return result;
    }

    // GET /api/me/activities/:activityId/track — GPS track for map overlay
    const trackMatch = path.match(/^\/api\/me\/activities\/([^/]+)\/track\/?$/);
    if (trackMatch && request.method === 'GET') {
      const activityId = trackMatch[1];
      const session = await getSessionFromRequest(request, env);
      if (!session) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleGetActivityTrack(activityId, session, env), request);
    }

    // GET /api/me/activities — OTW rowing, last month
    if ((path === '/api/me/activities' || path === '/api/me/activities/') && request.method === 'GET') {
      const session = await getSessionFromRequest(request, env);
      if (!session) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleGetActivities(session, env), request);
    }

    // POST /api/courses/{id}/calculate-time
    const calcMatch = path.match(/^\/api\/courses\/(\d+)\/calculate-time\/?$/);
    if (calcMatch && request.method === 'POST') {
      const courseId = calcMatch[1];
      const session = await getSessionFromRequest(request, env);
      if (!session) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleCalculateTime(request, courseId, session, env), request);
    }

    // POST /api/courses/{id}/course-times — save course time
    const saveMatch = path.match(/^\/api\/courses\/(\d+)\/course-times\/?$/);
    if (saveMatch && request.method === 'POST') {
      const courseId = saveMatch[1];
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleSaveCourseTime(request, courseId, athleteId, env), request);
    }

    // GET /api/me/course-times
    if ((path === '/api/me/course-times' || path === '/api/me/course-times/') && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleGetCourseTimes(athleteId, env), request);
    }

    // DELETE /api/me/course-times/:id
    const deleteMatch = path.match(/^\/api\/me\/course-times\/([^/]+)\/?$/);
    if (deleteMatch && request.method === 'DELETE') {
      const timeId = deleteMatch[1];
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true, request);
      return withCors(await handleDeleteCourseTime(timeId, athleteId, env), request);
    }

    // GET /api/challenges?status=active|upcoming|past
    const challengesListMatch = path.match(/^\/api\/challenges\/?$/);
    if (challengesListMatch && request.method === 'GET') {
      const status = url.searchParams.get('status') || 'active';
      const validStatus = ['active', 'upcoming', 'past'].includes(status) ? status : 'active';
      const result = await handleListChallenges(validStatus, env);
      return result;
    }

    // GET /api/challenges/:id/results
    const challengeResultsMatch = path.match(/^\/api\/challenges\/([^/]+)\/results\/?$/);
    if (challengeResultsMatch && request.method === 'GET') {
      const challengeId = challengeResultsMatch[1];
      const result = await handleChallengeResults(challengeId, env);
      return result;
    }

    // POST /api/challenges/:id/submit
    const challengeSubmitMatch = path.match(/^\/api\/challenges\/([^/]+)\/submit\/?$/);
    if (challengeSubmitMatch && request.method === 'POST') {
      const challengeId = challengeSubmitMatch[1];
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const result = await handleChallengeSubmit(request, challengeId, athleteId, env);
      return result;
    }

    // GET /api/challenges/:id
    const challengeDetailMatch = path.match(/^\/api\/challenges\/([^/]+)\/?$/);
    if (challengeDetailMatch && request.method === 'GET') {
      const challengeId = challengeDetailMatch[1];
      const result = await handleChallengeDetail(challengeId, env);
      return result;
    }

    // GET /api/organiser/challenges
    if ((path === '/api/organiser/challenges' || path === '/api/organiser/challenges/') && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const result = await handleOrganiserChallengesList(athleteId, env);
      return result;
    }

    // POST /api/organiser/challenges
    if ((path === '/api/organiser/challenges' || path === '/api/organiser/challenges/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const isOrg = await isOrganizer(athleteId, env);
      if (!isOrg) return jsonResponse({ error: 'Organiser access required' }, 403, true);
      const result = await handleCreateChallenge(request, athleteId, env, ctx);
      return result;
    }

    // GET /api/organiser/standard-collections
    if ((path === '/api/organiser/standard-collections' || path === '/api/organiser/standard-collections/') && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const result = await handleListStandardCollections(env);
      return result;
    }

    // POST /api/organiser/standard-collections
    if ((path === '/api/organiser/standard-collections' || path === '/api/organiser/standard-collections/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const isOrg = await isOrganizer(athleteId, env);
      if (!isOrg) return jsonResponse({ error: 'Organiser access required' }, 403, true);
      const result = await handleCreateStandardCollection(request, athleteId, env);
      return result;
    }

    // GET /api/organiser/challenges/:id/results — all results including pending (organiser only)
    const organiserResultsMatch = path.match(/^\/api\/organiser\/challenges\/([^/]+)\/results\/?$/);
    if (organiserResultsMatch && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const isOrg = await isOrganizer(athleteId, env);
      if (!isOrg) return jsonResponse({ error: 'Organiser access required' }, 403, true);
      const result = await handleOrganiserChallengeResults(organiserResultsMatch[1], athleteId, env);
      return result;
    }

    // POST /api/organiser/results/:id/override — approve or disqualify
    const organiserOverrideMatch = path.match(/^\/api\/organiser\/results\/([^/]+)\/override\/?$/);
    if (organiserOverrideMatch && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const isOrg = await isOrganizer(athleteId, env);
      if (!isOrg) return jsonResponse({ error: 'Organiser access required' }, 403, true);
      const result = await handleOrganiserResultOverride(request, organiserOverrideMatch[1], athleteId, env);
      return result;
    }

    // GET /api/organiser/results/:id/track — track overlay for moderation
    const organiserTrackMatch = path.match(/^\/api\/organiser\/results\/([^/]+)\/track\/?$/);
    if (organiserTrackMatch && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return jsonResponse({ error: 'Unauthorised' }, 401, true);
      const isOrg = await isOrganizer(athleteId, env);
      if (!isOrg) return jsonResponse({ error: 'Organiser access required' }, 403, true);
      const result = await handleOrganiserResultTrack(organiserTrackMatch[1], athleteId, env);
      return result;
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchFromGitHub(url: string, contentType: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) return new Response('Not found', { status: 404 });
  const body = await res.text();
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function bundleKml(ids: string[]): Promise<Response> {
  const folders = await Promise.all(ids.map(async id => {
    const res = await fetch(`${COURSES_BASE}/kml/${id}.kml`);
    if (!res.ok) return '';
    const text = await res.text();
    const match = text.match(/<Folder[\s\S]*<\/Folder>/);
    return match ? match[0] : '';
  }));

  const kml = `<?xml version="1.0" ?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>rownative courses</name>
    ${folders.filter(Boolean).join('\n    ')}
  </Document>
</kml>`;

  return new Response(kml, {
    headers: {
      'Content-Type': 'application/vnd.google-earth.kml+xml',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function getAthleteIdFromRequest(request: Request, env: Env): Promise<string | null> {
  const session = await getSessionFromRequest(request, env);
  if (session) return session.athleteId;
  // API key auth (CrewNerd)
  const authHeader = request.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('ApiKey ')) {
    const key = authHeader.slice(7);
    const dot = key.indexOf('.');
    if (dot === -1) return null;
    const athleteId = key.slice(0, dot);
    const mac = key.slice(dot + 1);
    const expected = await apiKeyForAthlete(athleteId, env.TOKEN_ENCRYPTION_KEY);
    const expectedMac = expected.slice(expected.indexOf('.') + 1);
    if (mac !== expectedMac) return null;
    return athleteId;
  }
  return null;
}

/** Fetch organisers.json from GitHub, cached in KV. Returns set of athlete IDs. */
async function getOrganiserIds(env: Env): Promise<Set<string>> {
  const cached = await env.ROWING_COURSES.get(ORGANISERS_CACHE_KEY);
  if (cached) {
    try {
      const arr = JSON.parse(cached) as unknown;
      const ids = Array.isArray(arr) ? arr.map((x) => String(x)) : [];
      return new Set(ids);
    } catch {
      // fall through to fetch
    }
  }
  const res = await fetch(`${COURSES_BASE}/courses/organisers.json`);
  if (!res.ok) {
    return new Set();
  }
  try {
    const arr = (await res.json()) as unknown;
    const ids = Array.isArray(arr) ? arr.map((x) => String(x)) : [];
    await env.ROWING_COURSES.put(ORGANISERS_CACHE_KEY, JSON.stringify(ids), {
      expirationTtl: ORGANISERS_CACHE_TTL,
    });
    return new Set(ids);
  } catch {
    return new Set();
  }
}

/** Check if athlete is an organiser (from organisers.json). */
async function isOrganizer(athleteId: string, env: Env): Promise<boolean> {
  const ids = await getOrganiserIds(env);
  return ids.has(athleteId);
}

/** Create a GitHub issue to notify admins of a new challenge. Fire-and-forget; failures are ignored. */
async function notifyAdminsNewChallenge(
  env: Env,
  challenge: { id: string; name: string; courseId: string; rowStart: string; rowEnd: string; submitEnd: string; athleteId: string }
): Promise<void> {
  const token = env.GITHUB_TOKEN;
  if (!token) return;
  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return;

  const viewUrl = `https://rownative.icu/challenge.html?id=${encodeURIComponent(challenge.id)}`;
  const title = `New challenge: ${challenge.name}`;
  const body = `Challenge created by organiser (athlete ID: ${challenge.athleteId}).

- **Name:** ${challenge.name}
- **Course:** ${challenge.courseId}
- **Row window:** ${challenge.rowStart} – ${challenge.rowEnd}
- **Submit deadline:** ${challenge.submitEnd}
- **View:** ${viewUrl}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'rownative-worker',
      },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      console.error('[notifyAdminsNewChallenge] GitHub API error:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[notifyAdminsNewChallenge] Failed:', e);
  }
}

/** Get session from cookie (browser auth). Returns null for API key. */
async function getSessionFromRequest(request: Request, env: Env): Promise<Session | null> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const match = cookieHeader.match(/rn_session=([^;]+)/);
  if (!match) return null;
  return decryptSession(match[1], env.TOKEN_ENCRYPTION_KEY);
}

async function apiKeyForAthlete(athleteId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(athleteId));
  const mac = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${athleteId}.${mac}`;
}

async function verifyIntervalsToken(bearerToken: string): Promise<string | null> {
  const res = await fetch('https://intervals.icu/api/v1/athlete/self', {
    headers: { 'Authorization': `Bearer ${bearerToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { id: string };
  return data.id ?? null;
}

interface Session {
  athleteId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function encryptSession(session: Session, secret: string): Promise<string> {
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  // Use URL-safe base64 (no +, /, or = padding) to avoid cookie-encoding pitfalls
  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function decryptSession(cookie: string, secret: string): Promise<Session | null> {
  try {
    const key = await getAesKey(secret);
    // Accept both URL-safe base64 (new) and standard base64 (legacy sessions)
    const normalized = cookie.replace(/-/g, '+').replace(/_/g, '/');
    // Restore stripped padding: base64 requires length to be a multiple of 4
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const combined = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as Session;
  } catch {
    return null;
  }
}

async function getAesKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret).slice(0, 32);
  const padded = new Uint8Array(32);
  padded.set(raw);
  return crypto.subtle.importKey('raw', padded, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── Import ZIP ─────────────────────────────────────────────────────────────────

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowOrigin =
    origin.includes('localhost') || origin.includes('127.0.0.1') ? origin : 'https://rownative.icu';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
  };
}

/** Apply CORS headers to a response (for local dev when request has localhost Origin). */
function withCors(res: Response, request: Request): Response {
  const headers = new Headers(res.headers);
  const cors = corsHeaders(request);
  headers.set('Access-Control-Allow-Origin', cors['Access-Control-Allow-Origin']);
  headers.set('Access-Control-Allow-Credentials', cors['Access-Control-Allow-Credentials']);
  return new Response(res.body, { status: res.status, headers });
}

function jsonResponse(body: object, status: number, withCors = false, request?: Request): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withCors) Object.assign(headers, corsHeaders(request ?? new Request('http://x')));
  return new Response(JSON.stringify(body), { status, headers });
}

interface Manifest {
  version?: number;
  exported_at?: string;
  owned?: Array<{ id: string; name?: string } | string>;
  liked?: Array<{ id: string; name?: string } | string>;
}

function extractIds(arr: Array<{ id: string; name?: string } | string> | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((o) => (typeof o === 'object' && o != null && 'id' in o ? o.id : String(o)));
}

async function handleImportZip(request: Request, env: Env, athleteId: string): Promise<Response> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 400, true);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Failed to parse form data' }, 400, true);
  }

  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'Missing file field' }, 400, true);
  }
  const zipBytes = new Uint8Array(await file.arrayBuffer());

  let zipContents: Record<string, Uint8Array>;
  try {
    zipContents = unzipSync(zipBytes);
  } catch {
    return jsonResponse({ error: 'Invalid ZIP file' }, 400, true);
  }

  const manifestBytes = zipContents['manifest.json'];
  if (!manifestBytes) {
    return jsonResponse({ error: 'Missing manifest.json' }, 400, true);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  } catch {
    return jsonResponse({ error: 'Invalid manifest.json' }, 400, true);
  }

  const ownedIds = extractIds(manifest.owned);
  const likedIds = extractIds(manifest.liked);

  const indexJson = await fetchCourseIndex(env);
  const existingIds = new Set(indexJson.map((e) => e.id));

  let alreadyInLibrary = 0;
  let prsOpened = 0;
  const prUrls: string[] = [];

  for (const id of ownedIds) {
    if (existingIds.has(id)) {
      alreadyInLibrary++;
      continue;
    }
    const kmlEntry = Object.entries(zipContents).find(([name]) => {
      const base = name.replace(/^.*\//, '').replace(/\.kml$/i, '');
      return base === id || name.endsWith(`_${id}.kml`);
    });
    if (!kmlEntry) continue;
    const [kmlPath, kmlBytes] = kmlEntry;
    const kmlText = new TextDecoder().decode(kmlBytes);
    const course = kmlToCourse(kmlText, id);
    if (!course) continue;

    const prResult = await openCoursePR(env, course, kmlText);
    if (prResult.ok) {
      prsOpened++;
      prUrls.push(prResult.prUrl);
    }
  }

  const kvKey = `liked:${athleteId}`;
  const currentLiked: string[] = JSON.parse((await env.ROWING_COURSES.get(kvKey)) ?? '[]');
  const updatedLiked = [...new Set([...currentLiked, ...likedIds])];
  await env.ROWING_COURSES.put(kvKey, JSON.stringify(updatedLiked));

  return jsonResponse(
    {
      alreadyInLibrary,
      prsOpened,
      prUrls,
      likedRestored: likedIds.length,
    },
    200,
    true
  );
}

function nextCourseId(indexJson: Array<{ id: string }>): string {
  const nums = indexJson
    .map((e) => parseInt(e.id, 10))
    .filter((n) => !Number.isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return String(max + 1);
}

/** Fetch index via GitHub API (less cached than raw) to avoid stale data when assigning next course ID. */
async function fetchCourseIndex(env: Env): Promise<Array<{ id: string }>> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return [];

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rownative-worker',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/courses/index.json?ref=main`,
    { headers }
  );
  if (!res.ok) return [];

  const meta = (await res.json()) as { content?: string; encoding?: string };
  const content = meta.content;
  if (!content || meta.encoding !== 'base64') return [];

  try {
    const json = JSON.parse(atob(content)) as unknown;
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

/** Check if courses/{id}.json exists on main (avoids 422 by pre-checking before PUT). */
async function courseFileExistsOnMain(env: Env, id: string): Promise<boolean> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName || !token) return false;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rownative-worker',
  };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/courses/${id}.json?ref=main`,
    { headers }
  );
  return res.ok;
}

/** Fetch courses/{id}.json from main; returns { sha, content } or null if not found. */
async function getCourseFileOnMain(
  env: Env,
  id: string
): Promise<{ sha: string; content: Record<string, unknown> } | null> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName || !token) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rownative-worker',
  };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/courses/${id}.json?ref=main`,
    { headers }
  );
  if (!res.ok) return null;

  const meta = (await res.json()) as { sha?: string; content?: string; encoding?: string };
  const sha = meta.sha;
  const content = meta.content;
  if (!sha || !content || meta.encoding !== 'base64') return null;

  try {
    const json = JSON.parse(atob(content)) as Record<string, unknown>;
    return { sha, content: json };
  } catch {
    return null;
  }
}

/** Get next course ID, skipping any that already exist on main (handles stale index). */
async function getNextAvailableCourseId(env: Env): Promise<string> {
  let indexJson = await fetchCourseIndex(env);
  let courseId = nextCourseId(indexJson);
  let attempts = 0;
  const maxAttempts = 5;
  while (await courseFileExistsOnMain(env, courseId) && attempts < maxAttempts) {
    indexJson = await fetchCourseIndex(env);
    const nums = indexJson
      .map((e) => parseInt(e.id, 10))
      .filter((n) => !Number.isNaN(n));
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    courseId = String(Math.max(max + 1, parseInt(courseId, 10) + 1));
    attempts++;
  }
  return courseId;
}

async function handleSubmitKml(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 400, true);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Failed to parse form data' }, 400, true);
  }

  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'Missing file field' }, 400, true);
  }
  const kmlText = await file.text();
  const nameOverride = formData.get('name');
  const name = typeof nameOverride === 'string' ? nameOverride.trim() : null;

  let courseId = await getNextAvailableCourseId(env);
  let course = kmlToCourse(kmlText, courseId);
  if (!course) {
    return jsonResponse(
      { error: 'KML must contain at least 2 polygons (start, waypoints, finish)' },
      400,
      true
    );
  }

  course.submitted_by = 'submitted via web form';
  if (name) course.name = name;

  let result = await openCoursePR(env, course, kmlText, 'web');

  // Retry once if 422 "sha" — file already exists (race or pre-check missed)
  if (!result.ok && /422|sha/i.test(result.error ?? '')) {
    courseId = await getNextAvailableCourseId(env);
    course = kmlToCourse(kmlText, courseId);
    if (course) {
      course.submitted_by = 'submitted via web form';
      if (name) course.name = name;
      result = await openCoursePR(env, course, kmlText, 'web');
    }
  }

  if (!result.ok) {
    const err = result.error ?? 'Failed to create pull request';
    const friendly =
      /422|sha/i.test(err)
        ? 'A course with this ID already exists (the index may have been temporarily stale). Please try again in a minute.'
        : err;
    return jsonResponse({ error: friendly }, 500, true);
  }

  return jsonResponse({ prUrl: result.prUrl }, 200, true);
}

async function handleUpdateKml(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 400, true);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Failed to parse form data' }, 400, true);
  }

  const idRaw = formData.get('id');
  const id = typeof idRaw === 'string' ? idRaw.trim() : '';
  if (!id) {
    return jsonResponse({ error: 'Course ID is required' }, 400, true);
  }

  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'Missing KML file' }, 400, true);
  }
  const kmlText = await file.text();
  const nameOverride = formData.get('name');
  const name = typeof nameOverride === 'string' ? nameOverride.trim() : null;

  const existing = await getCourseFileOnMain(env, id);
  if (!existing) {
    return jsonResponse({ error: 'Course not found' }, 404, true);
  }
  const existingStatus = (existing.content.status as string) ?? '';
  if (existingStatus !== 'provisional') {
    return jsonResponse(
      {
        error:
          'Only provisional courses can be updated via this form. Established courses must be edited directly in the repository.',
      },
      400,
      true
    );
  }

  const fromKml = kmlToCourse(kmlText, id);
  if (!fromKml) {
    return jsonResponse(
      { error: 'KML must contain at least 2 polygons (start, waypoints, finish)' },
      400,
      true
    );
  }

  const merged: Record<string, unknown> = {
    id,
    name: name ?? fromKml.name,
    country: existing.content.country,
    status: existing.content.status,
    notes: fromKml.notes,
    polygons: fromKml.polygons,
    center_lat: fromKml.center_lat,
    center_lon: fromKml.center_lon,
    distance_m: fromKml.distance_m,
    submitted_by: 'revision via web form',
  };

  const result = await openCourseUpdatePR(env, merged, existing.sha);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 500, true);
  }
  return jsonResponse({ prUrl: result.prUrl }, 200, true);
}

// ── Phase 2: Course times ─────────────────────────────────────────────────────

function lastMonthIso(): { oldest: string; newest: string } {
  const now = new Date();
  const newest = now.toISOString().slice(0, 10);
  const past = new Date(now);
  past.setDate(past.getDate() - 30);
  const oldest = past.toISOString().slice(0, 10);
  return { oldest, newest };
}

async function handleGetActivities(session: Session, env: Env): Promise<Response> {
  const { oldest, newest } = lastMonthIso();
  try {
    const activities = await fetchIntervalsActivities(
      session.athleteId,
      session.accessToken,
      oldest,
      newest
    );
    const otw = activities.filter(isOtwRowing);
    const out = otw.map((a) => ({
      id: a.id,
      name: a.name ?? 'Untitled',
      start_date_local: a.start_date_local,
      type: a.type,
    }));
    return jsonResponse({ activities: out }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch activities';
    return jsonResponse({ error: msg }, 502, true);
  }
}

async function handleGetActivityTrack(activityId: string, session: Session): Promise<Response> {
  try {
    const streams = await fetchIntervalsStreams(activityId, session.accessToken);
    const latlng = streams.latlng;
    if (!latlng || latlng.length < 2) {
      return jsonResponse({ error: 'Activity has no GPS track' }, 400, true);
    }
    const maxPoints = 600;
    const step = latlng.length <= maxPoints ? 1 : Math.ceil(latlng.length / maxPoints);
    const latlngForMap = latlng.filter((_, i) => i % step === 0);
    return jsonResponse({ latlng: latlngForMap }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch activity streams';
    return jsonResponse({ error: msg }, 502, true);
  }
}

async function handleCalculateTime(
  request: Request,
  courseId: string,
  session: Session,
  env: Env
): Promise<Response> {
  let body: { activityId?: string };
  try {
    body = (await request.json()) as { activityId?: string };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, true);
  }
  const activityId = body.activityId;
  if (!activityId) return jsonResponse({ error: 'activityId required' }, 400, true);

  // Fetch course JSON
  const courseRes = await fetch(`${COURSES_BASE}/courses/${courseId}.json`);
  if (!courseRes.ok) return jsonResponse({ error: 'Course not found' }, 404, true);
  const course = (await courseRes.json()) as { id: string; polygons: unknown[]; distance_m?: number };
  if (!course.polygons || course.polygons.length < 2) {
    return jsonResponse({ error: 'Invalid course' }, 400, true);
  }

  // Fetch streams
  let streams: { latlng?: [number, number][]; time?: number[] };
  try {
    streams = await fetchIntervalsStreams(activityId, session.accessToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch activity streams';
    return jsonResponse({ error: msg }, 502, true);
  }
  const latlng = streams.latlng;
  const time = streams.time;
  if (!latlng || !time || latlng.length < 2 || time.length < 2) {
    return jsonResponse({ error: 'Activity has no GPS track' }, 400, true);
  }
  const len = Math.min(latlng.length, time.length);
  const track: TrackPoint[] = [];
  for (let i = 0; i < len; i++) {
    const [lat, lon] = latlng[i];
    track.push({ lat, lon, time: time[i] });
  }

  const debugMode = new URL(request.url).searchParams.get('debug') === '1';

  const result = calculateCourseTime(
    course as { id: string; polygons: Array<{ name: string; order: number; points: Array<{ lat: number; lon: number }> }>; distance_m?: number },
    track,
    haversine,
    debugMode ? { debug: true } : undefined
  );

  // Downsample latlng for map overlay (max ~600 points)
  const maxPoints = 600;
  const step = latlng.length <= maxPoints ? 1 : Math.ceil(latlng.length / maxPoints);
  const latlngForMap = latlng.filter((_, i) => i % step === 0);

  const payload: Record<string, unknown> = {
    valid: result.valid,
    timeS: result.timeS,
    distanceM: result.distanceM,
    validationNote: result.validationNote,
    latlng: latlngForMap,
  };
  if (debugMode) {
    const tMin = len > 0 ? Math.min(...time.slice(0, len)) : 0;
    const tMax = len > 0 ? Math.max(...time.slice(0, len)) : 0;
    payload._debug = {
      track: { points: len, timeMin: tMin, timeMax: tMax, timeFirst3: time.slice(0, 3), timeLast3: time.slice(-3), latlngFirst: latlng[0], latlngLast: latlng[len - 1] },
      gates: result._debug,
    };
  }

  return jsonResponse(payload, 200, true, request);
}

async function handleSaveCourseTime(
  request: Request,
  courseId: string,
  athleteId: string,
  env: Env
): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  let body: { activityId: string; timeS: number; distanceM: number; validationNote?: string; workoutDate?: string; workoutName?: string };
  try {
    body = (await request.json()) as {
      activityId: string;
      timeS: number;
      distanceM: number;
      validationNote?: string;
      workoutDate?: string;
      workoutName?: string;
    };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, true);
  }
  const { activityId, timeS, distanceM, validationNote = '', workoutDate, workoutName } = body;
  if (!activityId || typeof timeS !== 'number' || typeof distanceM !== 'number') {
    return jsonResponse({ error: 'activityId, timeS, distanceM required' }, 400, true);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const wd = workoutDate && /^\d{4}-\d{2}-\d{2}/.test(workoutDate) ? workoutDate.slice(0, 10) : null;
  const wn = (workoutName && String(workoutName).trim()) || null;
  try {
    await env.DB.prepare(
      `INSERT INTO course_times (id, athlete_id, activity_id, course_id, time_s, distance_m, validation_note, created_at, workout_date, workout_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(athlete_id, activity_id, course_id) DO UPDATE SET
         time_s = excluded.time_s,
         distance_m = excluded.distance_m,
         validation_note = excluded.validation_note,
         created_at = excluded.created_at,
         workout_date = excluded.workout_date,
         workout_name = excluded.workout_name`
    )
      .bind(id, athleteId, activityId, courseId, timeS, distanceM, validationNote || '', createdAt, wd, wn)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
  return jsonResponse({ saved: true }, 200, true);
}

async function handleGetCourseTimes(athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  try {
    let results: Record<string, unknown>[];
    try {
      const r = await env.DB.prepare(
        `SELECT id, activity_id, course_id, time_s, distance_m, validation_note, created_at, workout_date, workout_name
         FROM course_times WHERE athlete_id = ? ORDER BY COALESCE(workout_date, created_at) DESC`
      )
        .bind(athleteId)
        .all();
      results = r.results ?? [];
    } catch (colErr) {
      const errMsg = colErr instanceof Error ? colErr.message : String(colErr);
      if (errMsg.includes('no such column') && errMsg.includes('workout_name')) {
        const r = await env.DB.prepare(
          `SELECT id, activity_id, course_id, time_s, distance_m, validation_note, created_at, workout_date
           FROM course_times WHERE athlete_id = ? ORDER BY COALESCE(workout_date, created_at) DESC`
        )
          .bind(athleteId)
          .all();
        results = r.results ?? [];
      } else if (errMsg.includes('no such column') && errMsg.includes('workout_date')) {
        const r = await env.DB.prepare(
          `SELECT id, activity_id, course_id, time_s, distance_m, validation_note, created_at
           FROM course_times WHERE athlete_id = ? ORDER BY created_at DESC`
        )
          .bind(athleteId)
          .all();
        results = r.results ?? [];
      } else {
        throw colErr;
      }
    }
    return jsonResponse({ courseTimes: results }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleDeleteCourseTime(timeId: string, athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  try {
    const r = await env.DB.prepare(
      'DELETE FROM course_times WHERE id = ? AND athlete_id = ?'
    )
      .bind(timeId, athleteId)
      .run();
    if (r.meta.changes === 0) return jsonResponse({ error: 'Not found' }, 404, true);
    return jsonResponse({ deleted: true }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

// ── Challenges API ───────────────────────────────────────────────────────────

const REMOVED_CHALLENGES_CACHE_KEY = 'removed-challenges:list';
const REMOVED_CHALLENGES_CACHE_TTL = 300;
const COURSE_INDEX_CACHE_KEY = 'course-index:json';
const COURSE_INDEX_CACHE_TTL = 300;

async function getRemovedChallengeIds(env: Env): Promise<Set<string>> {
  const cached = await env.ROWING_COURSES.get(REMOVED_CHALLENGES_CACHE_KEY);
  if (cached) {
    try {
      const arr = JSON.parse(cached) as unknown;
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      // fall through
    }
  }
  const res = await fetch(`${COURSES_BASE}/courses/removed-challenges.json`);
  if (!res.ok) return new Set();
  try {
    const arr = (await res.json()) as unknown;
    const ids = Array.isArray(arr) ? arr.map(String) : [];
    await env.ROWING_COURSES.put(REMOVED_CHALLENGES_CACHE_KEY, JSON.stringify(ids), {
      expirationTtl: REMOVED_CHALLENGES_CACHE_TTL,
    });
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function getCourseIndex(env: Env): Promise<Array<{ id: string; name?: string }>> {
  const cached = await env.ROWING_COURSES.get(COURSE_INDEX_CACHE_KEY);
  if (cached) {
    try {
      const arr = JSON.parse(cached) as unknown;
      return Array.isArray(arr) ? arr : [];
    } catch {
      // fall through
    }
  }
  const res = await fetch(`${COURSES_BASE}/courses/index.json`);
  if (!res.ok) return [];
  try {
    const arr = (await res.json()) as unknown;
    const courses = Array.isArray(arr) ? arr : [];
    await env.ROWING_COURSES.put(COURSE_INDEX_CACHE_KEY, JSON.stringify(courses), {
      expirationTtl: COURSE_INDEX_CACHE_TTL,
    });
    return courses;
  } catch {
    return [];
  }
}

function courseNameById(courses: Array<{ id: string; name?: string }>, id: string): string {
  const c = courses.find((x) => String(x.id) === String(id));
  return c?.name ?? `Course ${id}`;
}

const BUILTIN_COLLECTIONS: Record<string, string> = {
  hocr: 'HOCR',
  fisa: 'FISA Masters',
  charles: 'Charles River',
};

function collectionNameById(id: string | null, custom: Map<string, string>): string | null {
  if (!id) return null;
  if (BUILTIN_COLLECTIONS[id]) return BUILTIN_COLLECTIONS[id];
  return custom.get(id) ?? id;
}

function challengeToApi(row: Record<string, unknown>, courses: Array<{ id: string; name?: string }>, collectionNames: Map<string, string>): Record<string, unknown> {
  const courseId = String(row.course_id ?? '');
  const collectionId = row.collection_id ? String(row.collection_id) : null;
  return {
    id: row.id,
    name: row.name,
    courseId,
    courseName: courseNameById(courses, courseId),
    rowStart: row.row_start,
    rowEnd: row.row_end,
    submitEnd: row.submit_end,
    collectionId,
    collectionName: collectionNameById(collectionId, collectionNames),
    hasHandicap: !!collectionId,
    organizerId: row.organizer_id,
    resultsCount: row.results_count ?? 0,
    isPublic: (row.is_public ?? 1) !== 0,
    notes: row.notes ?? null,
  };
}

function challengeDetailToApi(row: Record<string, unknown>, courses: Array<{ id: string; name?: string }>, collectionNames: Map<string, string>): Record<string, unknown> {
  const base = challengeToApi(row, courses, collectionNames);
  return { ...base, organizerName: null };
}

async function handleListChallenges(status: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  const courses = await getCourseIndex(env);
  try {
    const r = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM challenge_results cr WHERE cr.challenge_id = c.id AND cr.validation_status IN ('valid', 'manual_ok')) as results_count
       FROM challenges c
       WHERE c.is_public = 1
       ORDER BY c.row_start DESC`
    )
      .all();
    const rows = (r.results ?? []) as Record<string, unknown>[];
    const customColls = await loadCollectionNames(env);
    const now = new Date();
    const filtered = rows
      .filter((row) => !removed.has(String(row.id ?? '')))
      .filter((row) => {
        const rs = row.row_start ? new Date(String(row.row_start)) : now;
        const re = row.row_end ? new Date(String(row.row_end)) : now;
        const se = row.submit_end ? new Date(String(row.submit_end)) : now;
        if (status === 'active') return rs <= now && now <= re && now <= se;
        if (status === 'upcoming') return rs > now;
        if (status === 'past') return re < now || se < now;
        return false;
      })
      .map((row) => challengeToApi(row, courses, customColls));
    return jsonResponse({ challenges: filtered }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function loadCollectionNames(env: Env): Promise<Map<string, string>> {
  if (!env.DB) return new Map();
  try {
    const r = await env.DB.prepare('SELECT id, name FROM standard_collections').all();
    const rows = (r.results ?? []) as Array<{ id: string; name: string }>;
    return new Map(rows.map((x) => [x.id, x.name]));
  } catch {
    return new Map();
  }
}

async function handleChallengeDetail(challengeId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  if (removed.has(challengeId)) return jsonResponse({ error: 'Not found' }, 404, true);
  try {
    const r = await env.DB.prepare(
      'SELECT * FROM challenges WHERE id = ? AND is_public = 1'
    )
      .bind(challengeId)
      .first();
    if (!r) return jsonResponse({ error: 'Not found' }, 404, true);
    const row = r as Record<string, unknown>;
    const courses = await getCourseIndex(env);
    const customColls = await loadCollectionNames(env);
    const api = challengeDetailToApi(row, courses, customColls);
    return jsonResponse(api, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleOrganiserChallengesList(athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  try {
    const r = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM challenge_results cr WHERE cr.challenge_id = c.id AND cr.validation_status IN ('valid', 'manual_ok')) as results_count
       FROM challenges c
       WHERE c.organizer_id = ?
       ORDER BY c.created_at DESC`
    )
      .bind(athleteId)
      .all();
    const rows = (r.results ?? []) as Record<string, unknown>[];
    const courses = await getCourseIndex(env);
    const customColls = await loadCollectionNames(env);
    const api = rows.map((row) => challengeToApi(row, courses, customColls));
    return jsonResponse({ challenges: api }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleCreateChallenge(request: Request, athleteId: string, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  let body: { name?: string; courseId?: string; rowStart?: string; rowEnd?: string; submitEnd?: string; collectionId?: string; notes?: string; isPublic?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, true);
  }
  const name = body.name?.trim();
  const courseId = body.courseId ? String(body.courseId) : null;
  const rowStart = body.rowStart ? String(body.rowStart).slice(0, 19) : null;
  const rowEnd = body.rowEnd ? String(body.rowEnd).slice(0, 19) : null;
  const submitEnd = body.submitEnd ? String(body.submitEnd).slice(0, 19) : null;
  if (!name || !courseId || !rowStart || !rowEnd || !submitEnd) {
    return jsonResponse({ error: 'name, courseId, rowStart, rowEnd, submitEnd required' }, 400, true);
  }
  const nameCheck = isNameAllowed(name);
  if (!nameCheck.allowed) {
    return jsonResponse({ error: nameCheck.reason ?? "That name isn't allowed." }, 400, true);
  }
  const collectionId = body.collectionId ? String(body.collectionId).trim() || null : null;
  const notes = body.notes?.trim() || null;
  const isPublic = body.isPublic !== false ? 1 : 0;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO challenges (id, name, course_id, row_start, row_end, submit_end, collection_id, organizer_id, is_public, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, name, courseId, rowStart, rowEnd, submitEnd, collectionId, athleteId, isPublic, notes, createdAt)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
  const courses = await getCourseIndex(env);
  const customColls = await loadCollectionNames(env);
  const challenge = challengeToApi(
    { id, name, course_id: courseId, row_start: rowStart, row_end: rowEnd, submit_end: submitEnd, collection_id: collectionId, organizer_id: athleteId, is_public: isPublic, notes, results_count: 0 },
    courses,
    customColls
  );

  if (ctx) {
    ctx.waitUntil(notifyAdminsNewChallenge(env, { id, name, courseId, rowStart, rowEnd, submitEnd, athleteId }));
  }

  return jsonResponse({ id, challenge }, 200, true);
}

async function handleListStandardCollections(env: Env): Promise<Response> {
  const builtin = [
    { id: 'hocr', name: 'HOCR', isBuiltin: true },
    { id: 'fisa', name: 'FISA Masters', isBuiltin: true },
    { id: 'charles', name: 'Charles River', isBuiltin: true },
  ];
  if (!env.DB) return jsonResponse({ collections: builtin }, 200, true);
  try {
    const r = await env.DB.prepare(
      'SELECT id, name, is_builtin FROM standard_collections ORDER BY created_at DESC'
    )
      .all();
    const rows = (r.results ?? []) as Array<{ id: string; name: string; is_builtin: number }>;
    const custom = rows.map((x) => ({
      id: x.id,
      name: x.name,
      isBuiltin: x.is_builtin !== 0,
    }));
    return jsonResponse({ collections: [...builtin, ...custom] }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ collections: builtin }, 200, true);
  }
}

function parseStandardTime(val: string): number | null {
  const s = String(val || '').trim();
  if (!s) return null;
  const num = parseFloat(s);
  if (!Number.isNaN(num) && num > 0) return num;
  const mmss = s.match(/^(\d+):(\d{2})$/);
  if (mmss) return parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10);
  return null;
}

async function handleCreateStandardCollection(request: Request, athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const contentType = request.headers.get('Content-Type') ?? '';
  let name = 'Custom collection';
  let csvText: string | null = null;
  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await request.formData();
      const n = formData.get('name');
      if (n && typeof n === 'string') name = n.trim() || name;
      const file = formData.get('file');
      if (file && file instanceof Blob) {
        csvText = await file.text();
      }
    } catch {
      // use default
    }
  } else {
    try {
      const body = (await request.json()) as { name?: string };
      if (body?.name?.trim()) name = body.name.trim();
    } catch {
      // use default
    }
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      'INSERT INTO standard_collections (id, name, is_builtin, organizer_id, created_at) VALUES (?, ?, 0, ?, ?)'
    )
      .bind(id, name, athleteId, createdAt)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
  if (csvText && csvText.trim()) {
    const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const header = lines[0]?.toLowerCase() ?? '';
    const cols = header.split(/[,\t]/).map((c) => c.trim().toLowerCase());
    const boatIdx = cols.findIndex((c) => c.includes('boattype') || c === 'boattype' || c === 'boat_class');
    const sexIdx = cols.findIndex((c) => c === 'sex');
    const wcIdx = cols.findIndex((c) => c.includes('weight') || c === 'weightclass');
    const timeIdx = cols.findIndex((c) => c.includes('coursetime') || c.includes('standard') || c === 'time');
    const distIdx = cols.findIndex((c) => c.includes('coursedistance') || c === 'distance');
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(/[,\t]/).map((c) => c.trim());
      const boatType = (boatIdx >= 0 ? cells[boatIdx] : '1x') || '1x';
      const sex = (sexIdx >= 0 ? cells[sexIdx] : 'M')?.toUpperCase().slice(0, 1) || 'M';
      const weightClass = (wcIdx >= 0 ? cells[wcIdx] : 'HWT') || 'HWT';
      const timeS = parseStandardTime(timeIdx >= 0 ? cells[timeIdx] : '');
      const distM = distIdx >= 0 ? parseFloat(cells[distIdx] || '') : NaN;
      const courseDistanceM = Number.isFinite(distM) && distM > 0 ? distM : 500;
      if (timeS != null && timeS > 0) {
        try {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO course_standards (collection_id, boat_type, sex, weight_class, course_distance_m, standard_time_s) VALUES (?, ?, ?, ?, ?, ?)'
          )
            .bind(id, boatType, sex, weightClass, courseDistanceM, timeS)
            .run();
        } catch {
          // skip row on error
        }
      }
    }
  }
  return jsonResponse({ id, message: 'Created' }, 200, true);
}

async function handleOrganiserChallengeResults(challengeId: string, athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const chRow = await env.DB.prepare('SELECT organizer_id FROM challenges WHERE id = ?').bind(challengeId).first();
  if (!chRow) return jsonResponse({ error: 'Challenge not found' }, 404, true);
  const organizerId = (chRow as { organizer_id: string }).organizer_id;
  if (organizerId !== athleteId) return jsonResponse({ error: 'Not your challenge' }, 403, true);
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM challenge_results WHERE challenge_id = ? ORDER BY raw_time_s ASC`
    )
      .bind(challengeId)
      .all();
    const rows = (r.results ?? []) as Record<string, unknown>[];
    const results = rows.map((row, i) => {
      const startTime = row.start_time ? String(row.start_time) : '';
      const workoutDate = startTime ? startTime.slice(0, 10) : null;
      return {
        id: row.id,
        rank: i + 1,
        challengeId: row.challenge_id,
        athleteId: row.athlete_id,
        activityId: row.activity_id,
        displayName: row.display_name ?? null,
        rawTimeS: row.raw_time_s,
        correctedTimeS: row.corrected_time_s ?? row.raw_time_s,
        points: row.points ?? null,
        boatType: row.boat_type ?? null,
        sex: row.sex ?? null,
        crewAvgAge: row.crew_avg_age != null ? Number(row.crew_avg_age) : null,
        workoutDate,
        validationStatus: row.validation_status ?? 'valid',
        validationNote: row.validation_note ?? null,
      };
    });
    return jsonResponse({ results }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleOrganiserResultOverride(request: Request, resultId: string, athleteId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  let body: { status?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, true);
  }
  const status = body.status === 'dq' ? 'dq' : 'manual_ok';
  const note = body.note ? String(body.note).trim().slice(0, 500) : '';

  const row = await env.DB.prepare(
    `SELECT cr.id, cr.challenge_id, c.organizer_id FROM challenge_results cr
     JOIN challenges c ON c.id = cr.challenge_id WHERE cr.id = ?`
  )
    .bind(resultId)
    .first();
  if (!row) return jsonResponse({ error: 'Result not found' }, 404, true);
  const r = row as { organizer_id: string };
  if (r.organizer_id !== athleteId) return jsonResponse({ error: 'Not your challenge' }, 403, true);

  await env.DB.prepare(
    'UPDATE challenge_results SET validation_status = ?, validation_note = ? WHERE id = ?'
  )
    .bind(status, note, resultId)
    .run();
  return jsonResponse({ updated: true }, 200, true);
}

async function handleOrganiserResultTrack(
  resultId: string,
  athleteId: string,
  env: Env
): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const row = await env.DB.prepare(
    `SELECT cr.track_latlng, c.organizer_id FROM challenge_results cr
     JOIN challenges c ON c.id = cr.challenge_id WHERE cr.id = ?`
  )
    .bind(resultId)
    .first();
  if (!row) return jsonResponse({ error: 'Result not found' }, 404, true);
  const r = row as { track_latlng: string | null; organizer_id: string };
  if (r.organizer_id !== athleteId) return jsonResponse({ error: 'Not your challenge' }, 403, true);

  let latlng: [number, number][];
  try {
    latlng = r.track_latlng ? (JSON.parse(r.track_latlng) as [number, number][]) : [];
  } catch {
    latlng = [];
  }
  if (!Array.isArray(latlng) || latlng.length < 2) return jsonResponse({ error: 'No GPS track stored' }, 400, true);

  return jsonResponse({ latlng }, 200, true);
}

async function handleChallengeResults(challengeId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  if (removed.has(challengeId)) return jsonResponse({ error: 'Not found' }, 404, true);
  const chRow = await env.DB.prepare('SELECT collection_id FROM challenges WHERE id = ?').bind(challengeId).first();
  const hasHandicap = chRow && (chRow as { collection_id: string | null }).collection_id != null;
  const orderCol = hasHandicap ? 'corrected_time_s' : 'raw_time_s';
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM challenge_results
       WHERE challenge_id = ? AND validation_status IN ('valid', 'manual_ok')
       ORDER BY ${orderCol} ASC`
    )
      .bind(challengeId)
      .all();
    const rows = (r.results ?? []) as Record<string, unknown>[];
    const results = rows.map((row, i) => {
      const startTime = row.start_time ? String(row.start_time) : '';
      const workoutDate = startTime ? startTime.slice(0, 10) : null;
      return {
        id: row.id,
        rank: i + 1,
        challengeId: row.challenge_id,
        athleteId: row.athlete_id,
        activityId: row.activity_id,
        displayName: row.display_name ?? null,
        rawTimeS: row.raw_time_s,
        correctedTimeS: row.corrected_time_s ?? row.raw_time_s,
        points: row.points ?? null,
        boatType: row.boat_type ?? null,
        sex: row.sex ?? null,
        crewAvgAge: row.crew_avg_age != null ? Number(row.crew_avg_age) : null,
        workoutDate,
        validationStatus: row.validation_status ?? 'valid',
      };
    });
    return jsonResponse({ results }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleChallengeSubmit(
  request: Request,
  challengeId: string,
  athleteId: string,
  env: Env
): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  if (removed.has(challengeId)) return jsonResponse({ error: 'Not found' }, 404, true);

  let body: { activityId?: string; displayName?: string; boatType?: string; sex?: string; weightClass?: string; crewAvgAge?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, true);
  }
  const activityId = body.activityId ? String(body.activityId).trim() : null;
  if (!activityId) return jsonResponse({ error: 'activityId required' }, 400, true);

  const session = await getSessionFromRequest(request, env);
  if (!session) return jsonResponse({ error: 'Unauthorised' }, 401, true);

  // Load challenge
  const chRow = await env.DB.prepare(
    'SELECT * FROM challenges WHERE id = ? AND is_public = 1'
  )
    .bind(challengeId)
    .first();
  if (!chRow) return jsonResponse({ error: 'Challenge not found' }, 404, true);
  const ch = chRow as Record<string, unknown>;
  const courseId = String(ch.course_id ?? '');
  const rowStart = ch.row_start ? String(ch.row_start).slice(0, 10) : '';
  const rowEnd = ch.row_end ? String(ch.row_end).slice(0, 10) : '';
  const submitEnd = ch.submit_end ? String(ch.submit_end) : '';

  const now = new Date();
  if (submitEnd && new Date(submitEnd) < now) {
    return jsonResponse({ error: 'Submissions closed' }, 400, true);
  }

  // Fetch activity for workout start date
  const activity = await fetchIntervalsActivity(activityId, session.accessToken);
  if (!activity) return jsonResponse({ error: 'Activity not found' }, 404, true);
  const startDateLocal = activity.start_date_local ? String(activity.start_date_local).slice(0, 10) : null;
  if (!startDateLocal) {
    return jsonResponse({ error: 'Activity has no start date' }, 400, true);
  }
  if (startDateLocal < rowStart || startDateLocal > rowEnd) {
    return jsonResponse({
      error: `Workout date ${startDateLocal} is outside the row window (${rowStart} – ${rowEnd})`,
    }, 400, true);
  }

  // Fetch course JSON
  const courseRes = await fetch(`${COURSES_BASE}/courses/${courseId}.json`);
  if (!courseRes.ok) return jsonResponse({ error: 'Course not found' }, 404, true);
  const course = (await courseRes.json()) as { id: string; polygons: unknown[]; distance_m?: number };
  if (!course.polygons || course.polygons.length < 2) {
    return jsonResponse({ error: 'Invalid course' }, 400, true);
  }

  // Fetch streams and run calculateCourseTime
  let streams: { latlng?: [number, number][]; time?: number[] };
  try {
    streams = await fetchIntervalsStreams(activityId, session.accessToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch activity streams';
    return jsonResponse({ error: msg }, 502, true);
  }
  const latlng = streams.latlng;
  const time = streams.time;
  if (!latlng || !time || latlng.length < 2 || time.length < 2) {
    return jsonResponse({ error: 'Activity has no GPS track' }, 400, true);
  }
  const len = Math.min(latlng.length, time.length);
  const track: TrackPoint[] = [];
  for (let i = 0; i < len; i++) {
    const [lat, lon] = latlng[i];
    track.push({ lat, lon, time: time[i] });
  }

  const validationLog: string[] = [];
  const result = calculateCourseTime(
    course as { id: string; polygons: Array<{ name: string; order: number; points: Array<{ lat: number; lon: number }> }>; distance_m?: number },
    track,
    haversine,
    { log: validationLog }
  );

  if (!result.valid) {
    return jsonResponse({
      error: 'Validation failed',
      validationNote: result.validationNote,
    }, 400, true);
  }

  const displayNameRaw = body.displayName?.trim() || null;
  if (displayNameRaw) {
    const displayCheck = isNameAllowed(displayNameRaw);
    if (!displayCheck.allowed) {
      return jsonResponse({ error: displayCheck.reason ?? "That name isn't allowed." }, 400, true);
    }
  }
  const displayName = displayNameRaw;
  const boatType = body.boatType ? String(body.boatType).trim() || null : null;
  const sex = body.sex ? String(body.sex).trim() || null : null;
  const weightClass = body.weightClass ? String(body.weightClass).trim() || null : null;

  let crewAvgAge: number | null = null;
  if (body.crewAvgAge != null) {
    const n = Number(body.crewAvgAge);
    if (!Number.isInteger(n) || n < 8 || n > 120) {
      return jsonResponse({ error: 'crewAvgAge must be an integer between 8 and 120' }, 400, true);
    }
    crewAvgAge = n;
  }

  const collectionId = ch.collection_id ? String(ch.collection_id) : null;
  const hasHandicap = !!collectionId;
  if (hasHandicap && (!boatType || !sex)) {
    return jsonResponse({ error: 'boatType and sex required for handicap challenges' }, 400, true);
  }
  const categoryKey = hasHandicap
    ? (boatType || '') + '|' + (sex || '') + '|' + (weightClass || '')
    : 'raw';
  let correctedTimeS = result.timeS;
  let points: number | null = null;
  if (collectionId && boatType && sex) {
    const courseDistanceM = (typeof course.distance_m === 'number' && course.distance_m > 0 ? course.distance_m : result.distanceM) || undefined;
    const handicap = await computeHandicap(
      collectionId,
      { rawTimeS: result.timeS, boatType, sex, weightClass: weightClass ?? undefined, courseDistanceM },
      env.DB
    );
    if (handicap) {
      correctedTimeS = handicap.correctedTimeS;
      points = handicap.points;
    }
  }

  const validationNote = result.validationNote || '';

  const maxPoints = 600;
  const step = latlng.length <= maxPoints ? 1 : Math.ceil(latlng.length / maxPoints);
  const trackLatlng = JSON.stringify(latlng.filter((_, i) => i % step === 0));

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const startTime = activity.start_date_local ? String(activity.start_date_local) : submittedAt;
  let resultId = id;
  let replaced = false;

  try {
    const existingForCategory = await env.DB.prepare(
      'SELECT id FROM challenge_results WHERE challenge_id = ? AND athlete_id = ? AND category_key = ?'
    )
      .bind(challengeId, athleteId, categoryKey)
      .first();
    replaced = !!existingForCategory;

    await env.DB.prepare(
      `INSERT INTO challenge_results (id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s, points, boat_type, sex, weight_class, crew_avg_age, start_time, validation_status, validation_note, track_latlng, submitted_at, category_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?)
       ON CONFLICT(challenge_id, athlete_id, category_key) DO UPDATE SET
         activity_id = excluded.activity_id,
         display_name = excluded.display_name,
         raw_time_s = excluded.raw_time_s,
         corrected_time_s = excluded.corrected_time_s,
         points = excluded.points,
         boat_type = excluded.boat_type,
         sex = excluded.sex,
         weight_class = excluded.weight_class,
         crew_avg_age = excluded.crew_avg_age,
         start_time = excluded.start_time,
         validation_status = 'valid',
         validation_note = excluded.validation_note,
         track_latlng = excluded.track_latlng,
         submitted_at = excluded.submitted_at`
    )
      .bind(id, challengeId, athleteId, activityId, displayName, result.timeS, correctedTimeS, points, boatType, sex, weightClass, crewAvgAge, startTime, validationNote, trackLatlng, submittedAt, categoryKey)
      .run();
    const existing = await env.DB.prepare(
      'SELECT id FROM challenge_results WHERE challenge_id = ? AND athlete_id = ? AND category_key = ?'
    )
      .bind(challengeId, athleteId, categoryKey)
      .first();
    resultId = (existing as { id: string } | null)?.id ?? id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }

  let rank: number;
  if (points != null) {
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM challenge_results
       WHERE challenge_id = ? AND validation_status IN ('valid', 'manual_ok') AND corrected_time_s <= ?`
    )
      .bind(challengeId, correctedTimeS)
      .first();
    rank = (countResult as { cnt: number })?.cnt ?? 1;
  } else {
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM challenge_results
       WHERE challenge_id = ? AND validation_status IN ('valid', 'manual_ok') AND raw_time_s <= ?`
    )
      .bind(challengeId, result.timeS)
      .first();
    rank = (countResult as { cnt: number })?.cnt ?? 1;
  }

  return jsonResponse({
    success: true,
    resultId,
    rank,
    rawTimeS: result.timeS,
    correctedTimeS,
    points,
    validationNote,
    replaced,
  }, 200, true);
}

type OpenCoursePRResult = { ok: true; prUrl: string } | { ok: false; error: string };

async function openCoursePR(
  env: Env,
  courseJson: { id: string; [k: string]: unknown },
  kmlContent: string,
  source: 'rowsandall' | 'web' = 'rowsandall'
): Promise<OpenCoursePRResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GitHub token not configured (GITHUB_TOKEN secret)' };

  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return { ok: false, error: 'Invalid GITHUB_REPO format' };

  const id = String(courseJson.id);
  const branchName = `import-course-${id}-${Date.now()}`;
  const courseName = courseJson.name ?? id;
  const title =
    source === 'web'
      ? `Add course ${id} from web submission`
      : `Import course ${id} from Rowsandall`;
  const body =
    source === 'web'
      ? `Submitted via rownative.icu. Course: ${courseName}`
      : `Migrated from Rowsandall export. Course: ${courseName}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rownative-worker',
  };

  async function ghError(res: Response): Promise<string> {
    const text = await res.text();
    let msg: string;
    try {
      const j = JSON.parse(text) as { message?: string };
      msg = j.message ?? text;
    } catch {
      msg = text || res.statusText;
    }
    return `GitHub API (${res.status}): ${msg}`;
  }

  const mainRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/main`, {
    headers,
  });
  if (!mainRes.ok) return { ok: false, error: await ghError(mainRes) };

  const mainRef = (await mainRes.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  const createBranchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if (!createBranchRes.ok) return { ok: false, error: await ghError(createBranchRes) };

  const courseJsonStr = JSON.stringify(courseJson, null, 2);
  const courseB64 = btoa(String.fromCharCode(...new TextEncoder().encode(courseJsonStr)));
  const kmlB64 = btoa(String.fromCharCode(...new TextEncoder().encode(kmlContent)));

  const putJson = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/courses/${id}.json`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add course ${id} from Rowsandall import`,
        content: courseB64,
        branch: branchName,
      }),
    }
  );
  if (!putJson.ok) return { ok: false, error: await ghError(putJson) };

  const putKml = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/kml/${id}.kml`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add KML for course ${id}`,
        content: kmlB64,
        branch: branchName,
      }),
    }
  );
  if (!putKml.ok) return { ok: false, error: await ghError(putKml) };

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      head: branchName,
      base: 'main',
      body,
    }),
  });
  if (!prRes.ok) return { ok: false, error: await ghError(prRes) };
  const pr = (await prRes.json()) as { html_url?: string };
  const prUrl = pr.html_url ?? null;
  return prUrl ? { ok: true, prUrl } : { ok: false, error: 'GitHub did not return PR URL' };
}

/** Open PR to update existing course JSON (provisional only). Does not PUT KML — deploy regenerates it. */
async function openCourseUpdatePR(
  env: Env,
  courseJson: Record<string, unknown>,
  jsonSha: string
): Promise<OpenCoursePRResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GitHub token not configured (GITHUB_TOKEN secret)' };

  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return { ok: false, error: 'Invalid GITHUB_REPO format' };

  const id = String(courseJson.id);
  const branchName = `update-course-${id}-${Date.now()}`;
  const courseName = (courseJson.name as string) ?? id;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rownative-worker',
  };

  async function ghError(res: Response): Promise<string> {
    const text = await res.text();
    let msg: string;
    try {
      const j = JSON.parse(text) as { message?: string };
      msg = j.message ?? text;
    } catch {
      msg = text || res.statusText;
    }
    return `GitHub API (${res.status}): ${msg}`;
  }

  const mainRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/main`, {
    headers,
  });
  if (!mainRes.ok) return { ok: false, error: await ghError(mainRes) };

  const mainRef = (await mainRes.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  const createBranchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if (!createBranchRes.ok) return { ok: false, error: await ghError(createBranchRes) };

  const courseJsonStr = JSON.stringify(courseJson, null, 2);
  const courseB64 = btoa(String.fromCharCode(...new TextEncoder().encode(courseJsonStr)));

  const putJson = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/courses/${id}.json`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Update course ${id} from KML revision`,
        content: courseB64,
        sha: jsonSha,
        branch: branchName,
      }),
    }
  );
  if (!putJson.ok) return { ok: false, error: await ghError(putJson) };

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Update course ${id} from KML revision`,
      head: branchName,
      base: 'main',
      body: `Revised geometry via rownative.icu. Course: ${courseName}`,
    }),
  });
  if (!prRes.ok) return { ok: false, error: await ghError(prRes) };
  const pr = (await prRes.json()) as { html_url?: string };
  const prUrl = pr.html_url ?? null;
  return prUrl ? { ok: true, prUrl } : { ok: false, error: 'GitHub did not return PR URL' };
}
