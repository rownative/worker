import { unzipSync } from 'fflate';
import { kmlToCourse, haversine, type CourseFromKml } from './kml-to-course';
import { calculateCourseTime, type TrackPoint } from './course-time';
import { computeHandicap } from './handicap';
import {
  fetchIntervalsActivities,
  fetchIntervalsActivity,
  fetchIntervalsAthleteProfile,
  fetchIntervalsAthleteProfileWithMeta,
  fetchIntervalsStreams,
  isOtwRowing,
  flattenAthleteJson,
  athleteIdFromPayload,
  type IntervalsActivity,
  type IntervalsAthleteSelfMeta,
} from './intervals-api';
import { isNameAllowed } from './content-filter';

// Rowing courses API
const COURSES_BASE = 'https://raw.githubusercontent.com/rownative/courses/main';
const GITHUB_API = 'https://api.github.com';
const ORGANISERS_CACHE_KEY = 'organisers:list';
const ORGANISERS_CACHE_TTL = 300; // 5 minutes

const MAX_ZIP_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_KML_UPLOAD_BYTES = 1 * 1024 * 1024;

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function isLocalOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLocalHostname(u.hostname);
  } catch {
    return false;
  }
}

function corsAllowOrigin(request: Request): string {
  const origin = request.headers.get('Origin') ?? '';
  return isLocalOrigin(origin) ? origin : 'https://rownative.icu';
}

/** For a clear error when `.dev.vars` is missing (local `wrangler dev` does not use `wrangler secret`). */
function missingIntervalsOAuthEnv(env: Env): string | null {
  if (!env.INTERVALS_CLIENT_ID?.trim()) return 'INTERVALS_CLIENT_ID';
  if (!env.INTERVALS_CLIENT_SECRET?.trim()) return 'INTERVALS_CLIENT_SECRET';
  return null;
}

/** Only http(s) to localhost or loopback; prevents open redirects via return_to. */
function safeLocalReturnTo(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!isLocalHostname(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** intervals.icu redirect_uri for local dev — must match this worker's origin (wrangler may use 8788 if 8787 is taken). */
function oauthRedirectUri(request: Request, isLocal: boolean): string {
  if (!isLocal) return 'https://rownative.icu/oauth/callback';
  const u = new URL(request.url);
  if (!isLocalHostname(u.hostname)) return 'http://localhost:8787/oauth/callback';
  return `${u.origin}/oauth/callback`;
}

function hostnameFromHostHeader(host: string): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function isLocalDevRequest(request: Request, requestUrl: URL): boolean {
  const host = request.headers.get('Host') ?? '';
  const origin = request.headers.get('Origin') ?? '';
  const hn = hostnameFromHostHeader(host);
  if (hn && isLocalHostname(hn)) return true;
  if (isLocalOrigin(origin)) return true;
  if (isLocalHostname(requestUrl.hostname)) return true;
  return false;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64UrlToBytes(s: string): Uint8Array | null {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function verifyApiKeyMac(athleteId: string, macBase64Url: string, secret: string): Promise<boolean> {
  const sig = base64UrlToBytes(macBase64Url);
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  try {
    return await crypto.subtle.verify(
      { name: 'HMAC', hash: 'SHA-256' },
      key,
      sig,
      new TextEncoder().encode(athleteId),
    );
  } catch {
    return false;
  }
}

async function githubApiError(res: Response): Promise<string> {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — required for credentialed POST from localhost
    if (request.method === 'OPTIONS') {
      const allowOrigin = corsAllowOrigin(request);
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

      const allowOrigin = corsAllowOrigin(request);
      return new Response(JSON.stringify({ courses: filtered }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Credentials': 'true',
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
      const liked: string[] = env.ROWING_COURSES ? JSON.parse((await env.ROWING_COURSES.get(`liked:${athleteId}`)) ?? '[]') : [];
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
      if (!env.ROWING_COURSES) {
        return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
      const meUrl = new URL(request.url);
      const debugMe = meUrl.searchParams.get('debug') === '1';
      const athleteId = await getAthleteIdFromRequest(request, env);
      let payload: {
        athleteId: string | null;
        liked: string[];
        isOrganizer?: boolean;
        athleteDisplayName?: string | null;
        _debug?: { intervalsAthleteSelf: IntervalsAthleteSelfMeta; profile?: { id: string; hasName: boolean; hasFirst: boolean; hasLast: boolean } | null };
      };
      if (athleteId) {
        const session = await getSessionFromRequest(request, env);
        let athleteDisplayName: string | undefined;
        let intervalsMeta: IntervalsAthleteSelfMeta | undefined;
        let profileSummary: { id: string; hasName: boolean; hasFirst: boolean; hasLast: boolean } | null = null;
        if (session?.accessToken) {
          const { profile, meta } = await fetchIntervalsAthleteProfileWithMeta(session.accessToken, athleteId);
          intervalsMeta = meta;
          if (profile) {
            const fromParts = [profile.first_name, profile.last_name]
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .map((s) => s.trim())
              .join(' ');
            athleteDisplayName = profile.name?.trim() || fromParts || undefined;
            profileSummary = {
              id: profile.id,
              hasName: !!profile.name?.trim(),
              hasFirst: !!profile.first_name?.trim(),
              hasLast: !!profile.last_name?.trim(),
            };
          }
          if (!athleteDisplayName && session.oauthAthleteName?.trim()) {
            athleteDisplayName = session.oauthAthleteName.trim();
          }
        }
        const [liked, isOrg] = await Promise.all([
          env.ROWING_COURSES ? env.ROWING_COURSES.get(`liked:${athleteId}`).then((v) => JSON.parse(v ?? '[]') as string[]) : Promise.resolve([]),
          isOrganizer(athleteId, env, request),
        ]);
        // Always include athleteDisplayName (null if unresolved) — JSON.stringify omits undefined keys.
        payload = {
          athleteId,
          liked,
          isOrganizer: isOrg,
          athleteDisplayName: athleteDisplayName ?? null,
        };
        if (debugMe && intervalsMeta) {
          payload._debug = { intervalsAthleteSelf: intervalsMeta, profile: profileSummary };
        }
      } else {
        payload = { athleteId: null, liked: [], isOrganizer: false, athleteDisplayName: null };
      }
      const allowOrigin = corsAllowOrigin(request);
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
      const result = await verifyIntervalsToken(bearerToken);
      if (!result.athleteId) {
        const errorMessage = result.errorHint || 'Invalid token';
        return new Response(errorMessage, { status: 401 });
      }
      const apiKey = await apiKeyForAthlete(result.athleteId, env.TOKEN_ENCRYPTION_KEY);
      return new Response(JSON.stringify({ api_key: apiKey }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // OAuth debug — show exact redirect_uri for copying into intervals.icu app settings
    if (path === '/oauth/debug') {
      const localParam = url.searchParams.get('local') === '1';
      const hostHeader = request.headers.get('Host') ?? '';
      const hostName = hostnameFromHostHeader(hostHeader);
      const isLocalByHost = hostName !== null && isLocalHostname(hostName);
      const isLocalByUrl = isLocalHostname(url.hostname);
      const isLocal = localParam || isLocalByHost || isLocalByUrl;
      const redirectUri = oauthRedirectUri(request, isLocal);
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
      const missingOAuth = missingIntervalsOAuthEnv(env);
      if (missingOAuth) {
        return new Response(
          `OAuth not configured: ${missingOAuth} is empty. For local dev, copy .dev.vars.example to .dev.vars and set values (wrangler secret put does not apply to npm run dev). See README.`,
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }
      const localParam = url.searchParams.get('local') === '1';
      const hostHeader = request.headers.get('Host') ?? '';
      const hostName = hostnameFromHostHeader(hostHeader);
      const isLocal = localParam
        || (hostName !== null && isLocalHostname(hostName))
        || isLocalHostname(url.hostname);
      const redirectUri = oauthRedirectUri(request, isLocal);
      const state = crypto.randomUUID();
      const returnToParam = url.searchParams.get('return_to');
      const safeReturn = safeLocalReturnTo(returnToParam);
      console.log(`[oauth] authorize: generated state=${state}, redirect_uri=${redirectUri}`);
      // Store state in KV; value 'local' or 'local:<returnTo>' signals local dev
      const stateVal = isLocal ? (safeReturn ? `local:${safeReturn}` : 'local') : '1';
      if (env.ROWING_COURSES) {
        await env.ROWING_COURSES.put(`oauth_state:${state}`, stateVal, { expirationTtl: 600 });
      }
      const params = new URLSearchParams({
        client_id: env.INTERVALS_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        // ACTIVITY: streams/activities; SETTINGS: athlete profile GET (forum: "Athlete settings")
        scope: 'ACTIVITY:READ,SETTINGS:READ',
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
      const kvVal = state && env.ROWING_COURSES ? await env.ROWING_COURSES.get(`oauth_state:${state}`) : null;
      if (!storedState && kvVal) storedState = state;
      console.log(`[oauth] callback: code present=${!!code}, state from URL=${state}`);
      console.log(`[oauth] callback: cookie header present=${cookieHeader.length > 0}, stored state=${storedState}`);
      console.log(`[oauth] callback: state match=${!!state && !!storedState && state === storedState}`);
      if (!code || !state || !storedState || state !== storedState) {
        const reason = !code ? 'Missing code' : 'Invalid state';
        console.log(`[oauth] callback: validation failed — ${reason}`);
        return new Response(reason, { status: 400 });
      }
      if (env.ROWING_COURSES) {
        await env.ROWING_COURSES.delete(`oauth_state:${state}`);
      }
      const isLocal = kvVal === 'local' || (typeof kvVal === 'string' && kvVal.startsWith('local:'));
      const returnToRaw = (typeof kvVal === 'string' && kvVal.startsWith('local:')) ? kvVal.slice(6) : null;
      const returnTo = safeLocalReturnTo(returnToRaw);

      const redirectUri = oauthRedirectUri(request, isLocal);

      const missingOAuthCb = missingIntervalsOAuthEnv(env);
      if (missingOAuthCb) {
        return new Response(
          `OAuth not configured: ${missingOAuthCb} is empty. Copy .dev.vars.example to .dev.vars and set values. See README.`,
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }

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

      // Token response includes athlete id + name (see intervals.icu OAuth docs) — persist name for /api/me when GET /athlete/* returns 403.
      const tokens = await tokenRes.json() as {
        access_token: string;
        scope?: string;
        athlete?: { id?: string | number; name?: string };
      };
      if (!tokens.access_token) {
        return new Response('Token exchange: missing access_token', { status: 500 });
      }
      const ath = tokens.athlete;
      if (!ath || ath.id == null) {
        return new Response('Token exchange: missing athlete', { status: 500 });
      }
      const athleteId =
        typeof ath.id === 'number' && Number.isFinite(ath.id) ? String(ath.id) : String(ath.id).trim();
      const oauthAthleteName =
        typeof ath.name === 'string' && ath.name.trim() ? ath.name.trim() : undefined;

      // Encrypt session and set cookie
      // intervals.icu does not use refresh tokens or expiry — store access token only
      const session: Session = {
        athleteId,
        accessToken: tokens.access_token,
        refreshToken: '',
        expiresAt: 0, // no expiry
        ...(oauthAthleteName ? { oauthAthleteName } : {}),
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
      const returnToParam = url.searchParams.get('return_to');
      const safeReturn = safeLocalReturnTo(returnToParam);
      const hostHeader = request.headers.get('Host') ?? '';
      const hostName = hostnameFromHostHeader(hostHeader);
      const isLocal = localParam
        || (hostName !== null && isLocalHostname(hostName))
        || isLocalHostname(url.hostname);
      const logoutRedirect = (isLocal && safeReturn) ? safeReturn : (isLocal ? 'http://localhost:8080/' : '/');
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
      return withCors(await handleGetActivityTrack(activityId, session), request);
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
      return withCors(await handleSaveCourseTime(request, courseId, athleteId, env, ctx), request);
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
      return withCors(await handleListChallenges(validStatus, env), request);
    }

    // GET /api/challenges/:id/results
    const challengeResultsMatch = path.match(/^\/api\/challenges\/([^/]+)\/results\/?$/);
    if (challengeResultsMatch && request.method === 'GET') {
      const challengeId = challengeResultsMatch[1];
      return withCors(await handleChallengeResults(challengeId, env), request);
    }

    // POST /api/challenges/:id/submit
    const challengeSubmitMatch = path.match(/^\/api\/challenges\/([^/]+)\/submit\/?$/);
    if (challengeSubmitMatch && request.method === 'POST') {
      const challengeId = challengeSubmitMatch[1];
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleChallengeSubmit(request, challengeId, athleteId, env), request);
    }

    // GET /api/challenges/:id
    const challengeDetailMatch = path.match(/^\/api\/challenges\/([^/]+)\/?$/);
    if (challengeDetailMatch && request.method === 'GET') {
      const challengeId = challengeDetailMatch[1];
      return withCors(await handleChallengeDetail(challengeId, env), request);
    }

    // GET /api/organiser/challenges
    if ((path === '/api/organiser/challenges' || path === '/api/organiser/challenges/') && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleOrganiserChallengesList(athleteId, env), request);
    }

    // POST /api/organiser/challenges
    if ((path === '/api/organiser/challenges' || path === '/api/organiser/challenges/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      const isOrg = await isOrganizer(athleteId, env, request);
      if (!isOrg) return withCors(jsonResponse({ error: 'Organiser access required' }, 403, true), request);
      return withCors(await handleCreateChallenge(request, athleteId, env, ctx), request);
    }

    // GET /api/organiser/standard-collections
    if ((path === '/api/organiser/standard-collections' || path === '/api/organiser/standard-collections/') && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleListStandardCollections(env), request);
    }

    // POST /api/organiser/standard-collections
    if ((path === '/api/organiser/standard-collections' || path === '/api/organiser/standard-collections/') && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      const isOrg = await isOrganizer(athleteId, env, request);
      if (!isOrg) return withCors(jsonResponse({ error: 'Organiser access required' }, 403, true), request);
      return withCors(await handleCreateStandardCollection(request, athleteId, env), request);
    }

    // GET /api/organiser/challenges/:id/results — challenge organiser only (handler checks organizer_id)
    const organiserResultsMatch = path.match(/^\/api\/organiser\/challenges\/([^/]+)\/results\/?$/);
    if (organiserResultsMatch && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleOrganiserChallengeResults(organiserResultsMatch[1], athleteId, env), request);
    }

    // POST /api/organiser/results/:id/override — approve or disqualify (handler checks challenge organiser)
    const organiserOverrideMatch = path.match(/^\/api\/organiser\/results\/([^/]+)\/override\/?$/);
    if (organiserOverrideMatch && request.method === 'POST') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleOrganiserResultOverride(request, organiserOverrideMatch[1], athleteId, env), request);
    }

    // GET /api/organiser/results/:id/track — track overlay for moderation (handler checks challenge organiser)
    const organiserTrackMatch = path.match(/^\/api\/organiser\/results\/([^/]+)\/track\/?$/);
    if (organiserTrackMatch && request.method === 'GET') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleOrganiserResultTrack(organiserTrackMatch[1], athleteId, env), request);
    }

    // DELETE /api/organiser/challenges/:id — remove challenge (handler checks organizer_id)
    const organiserDeleteMatch = path.match(/^\/api\/organiser\/challenges\/([^/]+)\/?$/);
    if (organiserDeleteMatch && request.method === 'DELETE') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return withCors(jsonResponse({ error: 'Unauthorised' }, 401, true), request);
      return withCors(await handleDeleteChallenge(request, organiserDeleteMatch[1], athleteId, env), request);
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
  
  const authHeader = request.headers.get('Authorization') ?? '';
  
  // API key auth (CrewNerd new flow)
  if (authHeader.startsWith('ApiKey ')) {
    const key = authHeader.slice(7);
    const dot = key.indexOf('.');
    if (dot === -1) return null;
    const athleteId = key.slice(0, dot);
    const mac = key.slice(dot + 1);
    const ok = await verifyApiKeyMac(athleteId, mac, env.TOKEN_ENCRYPTION_KEY);
    if (!ok) return null;
    return athleteId;
  }
  
  // Bearer token auth (CrewNerd backward compatibility)
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    const athleteId = await verifyBearerTokenCached(bearerToken, env);
    return athleteId;
  }
  
  return null;
}

/** Fetch organisers.json from GitHub, cached in KV. Returns set of athlete IDs. */
async function getOrganiserIds(env: Env): Promise<Set<string>> {
  if (env.ROWING_COURSES) {
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
  }
  const res = await fetch(`${COURSES_BASE}/courses/organisers.json`);
  if (!res.ok) {
    return new Set();
  }
  try {
    const arr = (await res.json()) as unknown;
    const ids = Array.isArray(arr) ? arr.map((x) => String(x)) : [];
    if (env.ROWING_COURSES) {
      await env.ROWING_COURSES.put(ORGANISERS_CACHE_KEY, JSON.stringify(ids), {
        expirationTtl: ORGANISERS_CACHE_TTL,
      });
    }
    return new Set(ids);
  } catch {
    return new Set();
  }
}

/** Check if athlete is an organiser (from organisers.json). */
async function isOrganizer(athleteId: string, env: Env, request?: Request): Promise<boolean> {
  if (request) {
    const reqUrl = new URL(request.url);
    if (isLocalDevRequest(request, reqUrl)) {
      return true; // dev: any signed-in user can act as organiser
    }
  }
  const ids = await getOrganiserIds(env);
  return ids.has(athleteId);
}

/** Shared helper: open a GitHub issue in GITHUB_REPO. Fire-and-forget callers use waitUntil. */
async function postGithubIssue(env: Env, title: string, body: string): Promise<void> {
  const token = env.GITHUB_TOKEN;
  if (!token) return;
  const repo = env.GITHUB_REPO ?? 'rownative/courses';
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return;

  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/issues`, {
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
      console.error('[postGithubIssue] GitHub API error:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[postGithubIssue] Failed:', e);
  }
}

const ESTABLISHED_STATUS_PROMPT = `Please consider updating the course JSON in this repo to set \`status\` to \`established\` once the geometry is considered validated.`;

/** Create a GitHub issue to notify admins of a new challenge. Fire-and-forget; failures are ignored. */
async function notifyAdminsNewChallenge(
  env: Env,
  challenge: {
    id: string;
    name: string;
    courseId: string;
    rowStart: string;
    rowEnd: string;
    submitEnd: string;
    athleteId: string;
    courseIsProvisional?: boolean;
  }
): Promise<void> {
  const viewUrl = `https://rownative.icu/challenge.html?id=${encodeURIComponent(challenge.id)}`;
  const title = `New challenge: ${challenge.name}`;
  let body = `Challenge created by organiser (athlete ID: ${challenge.athleteId}).

- **Name:** ${challenge.name}
- **Course:** ${challenge.courseId}
- **Row window:** ${challenge.rowStart} – ${challenge.rowEnd}
- **Submit deadline:** ${challenge.submitEnd}
- **View:** ${viewUrl}`;

  if (challenge.courseIsProvisional) {
    body += `

---

### Provisional course
This challenge uses course **${challenge.courseId}**, which is still **provisional** in \`courses/index.json\`. ${ESTABLISHED_STATUS_PROMPT}`;
  }

  await postGithubIssue(env, title, body);
}

/** First saved measured time for a provisional course (any athlete). */
async function notifyAdminsProvisionalCourseFirstMeasuredTime(
  env: Env,
  payload: { courseId: string; courseName: string; athleteId: string }
): Promise<void> {
  const mapUrl = `https://rownative.icu/index.html#course-${encodeURIComponent(payload.courseId)}`;
  const title = `Provisional course ${payload.courseId}: first measured time saved`;
  const body = `A measured time was saved for provisional course **${payload.courseName}** (\`${payload.courseId}\`). This is the **first** saved time for this course in the database (saved by athlete ID ${payload.athleteId}).

${ESTABLISHED_STATUS_PROMPT}

- **Map:** ${mapUrl}`;

  await postGithubIssue(env, title, body);
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
  const mac = uint8ToBase64(new Uint8Array(sig))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${athleteId}.${mac}`;
}

/** If bearer is a JWT, try to read athlete id for /api/v1/athlete/{id} (self often 403 for OAuth). */
function tryIntervalsJwtAthleteId(bearerToken: string): string | null {
  const parts = bearerToken.split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    const p = JSON.parse(json) as Record<string, unknown>;
    for (const k of ['athleteId', 'athlete_id', 'sub']) {
      const v = p[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  } catch {
    return null;
  }
  return null;
}

/** Verify Bearer token with KV caching (1h TTL). Returns athleteId or null. */
async function verifyBearerTokenCached(bearerToken: string, env: Env): Promise<string | null> {
  // Compute SHA-256 hash of token for cache key (avoid storing raw tokens)
  const encoder = new TextEncoder();
  const data = encoder.encode(bearerToken);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const hashPrefix = hashHex.slice(0, 16);
  
  const cacheKey = `bearer-token:sha256:${hashPrefix}`;
  const cached = env.ROWING_COURSES ? await env.ROWING_COURSES.get(cacheKey) : null;
  
  if (cached) {
    console.log(`[verifyBearerTokenCached] Cache hit for token prefix ${bearerToken.slice(0, 8)}...`);
    return cached; // cached athleteId
  }
  
  console.log(`[verifyBearerTokenCached] Cache miss for token prefix ${bearerToken.slice(0, 8)}..., validating with intervals.icu`);
  const result = await verifyIntervalsToken(bearerToken);
  
  if (result.athleteId && env.ROWING_COURSES) {
    // Cache for 1 hour (3600 seconds)
    await env.ROWING_COURSES.put(cacheKey, result.athleteId, {
      expirationTtl: 3600,
    });
    console.log(`[verifyBearerTokenCached] Cached athleteId ${result.athleteId} for 1 hour`);
  }
  
  return result.athleteId;
}

async function verifyIntervalsToken(bearerToken: string): Promise<{ athleteId: string | null; errorHint?: string }> {
  const tokenPrefix = bearerToken.slice(0, 8);
  const isJwtFormat = bearerToken.split('.').length === 3;
  console.log(`[verifyIntervalsToken] Token format: ${isJwtFormat ? 'JWT' : 'plain OAuth'} (prefix: ${tokenPrefix}...)`);
  
  // Try /athlete/0 first (most reliable, works for all OAuth tokens per intervals.icu API)
  const athlete0Url = 'https://intervals.icu/api/v1/athlete/0';
  console.log('[verifyIntervalsToken] Trying /athlete/0');
  const res0 = await fetch(athlete0Url, {
    headers: { 'Authorization': `Bearer ${bearerToken}` },
  });
  
  if (res0.ok) {
    try {
      const text = await res0.text();
      console.log(`[verifyIntervalsToken] /athlete/0 returned 200 OK, response length: ${text.length} bytes`);
      const raw = text ? JSON.parse(text) : null;
      const topLevelKeys = raw && typeof raw === 'object' && raw !== null ? Object.keys(raw as object) : [];
      const hasNestedAthlete = raw && typeof raw === 'object' && 'athlete' in (raw as object);
      console.log(`[verifyIntervalsToken] Response keys: [${topLevelKeys.join(', ')}], nested athlete: ${hasNestedAthlete}`);
      
      const data = flattenAthleteJson(raw);
      if (data) {
        const athleteId = athleteIdFromPayload(data);
        if (athleteId) {
          console.log(`[verifyIntervalsToken] SUCCESS: Extracted athlete ID: ${athleteId}`);
          return { athleteId };
        }
        console.error('[verifyIntervalsToken] /athlete/0 returned OK but no athlete ID found in response after flattening');
      } else {
        console.error('[verifyIntervalsToken] /athlete/0 returned OK but flattenAthleteJson returned null');
      }
    } catch (e) {
      console.error('[verifyIntervalsToken] /athlete/0 JSON parse error:', e);
    }
  } else {
    const bearerStatus = res0.status;
    const bearerErrorText = await res0.text().catch(() => '');
    console.error(`[verifyIntervalsToken] /athlete/0 Bearer failed: ${bearerStatus}, body: ${bearerErrorText.slice(0, 200)}`);

    // Check for OAuth scope issues
    if (bearerStatus === 403 && bearerErrorText.includes('SETTINGS:READ scope required')) {
      console.log('[verifyIntervalsToken] Detected missing OAuth scope - token needs re-authorization');
      return { 
        athleteId: null, 
        errorHint: 'Your authorization needs to be updated. Please log out and log in again to grant the required permissions.' 
      };
    }

    // Fallback: try the token as an intervals.icu API key using HTTP Basic auth.
    // intervals.icu API keys require: Authorization: Basic <base64("API_KEY:" + key)>
    if (bearerStatus === 401 || bearerStatus === 403) {
      console.log('[verifyIntervalsToken] Trying /athlete/0 with API key Basic auth');
      let basicAuth: string;
      try {
        basicAuth = `Basic ${btoa('API_KEY:' + bearerToken)}`;
      } catch (e) {
        console.error('[verifyIntervalsToken] Failed to encode API key for Basic auth (non-ASCII characters?):', e);
        basicAuth = '';
      }
      if (basicAuth) {
        const res0Basic = await fetch(athlete0Url, {
          headers: { 'Authorization': basicAuth },
        });
        if (res0Basic.ok) {
          try {
            const text = await res0Basic.text();
            console.log(`[verifyIntervalsToken] /athlete/0 API key Basic auth returned 200 OK, response length: ${text.length} bytes`);
            const raw = text ? JSON.parse(text) : null;
            const topLevelKeys = raw && typeof raw === 'object' && raw !== null ? Object.keys(raw as object) : [];
            const hasNestedAthlete = raw && typeof raw === 'object' && 'athlete' in (raw as object);
            console.log(`[verifyIntervalsToken] Response keys: [${topLevelKeys.join(', ')}], nested athlete: ${hasNestedAthlete}`);
            const data = flattenAthleteJson(raw);
            if (data) {
              const athleteId = athleteIdFromPayload(data);
              if (athleteId) {
                console.log(`[verifyIntervalsToken] SUCCESS via API key Basic auth: Extracted athlete ID: ${athleteId}`);
                return { athleteId };
              }
              console.error('[verifyIntervalsToken] /athlete/0 API key Basic auth returned OK but no athlete ID found after flattening');
            } else {
              console.error('[verifyIntervalsToken] /athlete/0 API key Basic auth returned OK but flattenAthleteJson returned null');
            }
          } catch (e) {
            console.error('[verifyIntervalsToken] /athlete/0 API key Basic auth JSON parse error:', e);
          }
        } else {
          const basicErrorText = await res0Basic.text().catch(() => '');
          console.error(`[verifyIntervalsToken] /athlete/0 API key Basic auth failed: ${res0Basic.status}, body: ${basicErrorText.slice(0, 200)}`);
        }
      }
    }
  }

  // Fallback: try JWT-decoded athlete ID if available
  const jwtId = tryIntervalsJwtAthleteId(bearerToken);
  if (jwtId) {
    console.log(`[verifyIntervalsToken] JWT decoded athlete ID: ${jwtId}, trying /athlete/${jwtId}`);
    const jwtUrl = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(jwtId)}`;
    const resJwt = await fetch(jwtUrl, {
      headers: { 'Authorization': `Bearer ${bearerToken}` },
    });
    
    if (resJwt.ok) {
      try {
        const text = await resJwt.text();
        console.log(`[verifyIntervalsToken] /athlete/${jwtId} returned 200 OK, response length: ${text.length} bytes`);
        const raw = text ? JSON.parse(text) : null;
        const topLevelKeys = raw && typeof raw === 'object' && raw !== null ? Object.keys(raw as object) : [];
        const hasNestedAthlete = raw && typeof raw === 'object' && 'athlete' in (raw as object);
        console.log(`[verifyIntervalsToken] Response keys: [${topLevelKeys.join(', ')}], nested athlete: ${hasNestedAthlete}`);
        
        const data = flattenAthleteJson(raw);
        if (data) {
          const athleteId = athleteIdFromPayload(data);
          if (athleteId) {
            console.log(`[verifyIntervalsToken] SUCCESS: Extracted athlete ID: ${athleteId}`);
            return { athleteId };
          }
          console.error(`[verifyIntervalsToken] /athlete/${jwtId} returned OK but no athlete ID found in response after flattening`);
        } else {
          console.error(`[verifyIntervalsToken] /athlete/${jwtId} returned OK but flattenAthleteJson returned null`);
        }
      } catch (e) {
        console.error(`[verifyIntervalsToken] /athlete/${jwtId} JSON parse error:`, e);
      }
    } else {
      const errorText = await resJwt.text().catch(() => '');
      console.error(`[verifyIntervalsToken] /athlete/${jwtId} failed: ${resJwt.status}, body: ${errorText.slice(0, 200)}`);
    }
  } else {
    console.log('[verifyIntervalsToken] Token is not JWT format, no fallback endpoint to try');
  }

  console.error('[verifyIntervalsToken] All attempts failed, returning null');
  return { athleteId: null };
}

interface Session {
  athleteId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Display name from OAuth token exchange (intervals.icu returns athlete.name); used when GET /api/v1/athlete/* is forbidden. */
  oauthAthleteName?: string;
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
  return uint8ToBase64(combined)
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
  return {
    'Access-Control-Allow-Origin': corsAllowOrigin(request),
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
    return jsonResponse({ error: 'Missing file field' }, 400, true, request);
  }
  if (file.size > MAX_ZIP_UPLOAD_BYTES) {
    return jsonResponse({ error: 'ZIP file too large (max 10 MB)' }, 413, true, request);
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
  const currentLiked: string[] = env.ROWING_COURSES ? JSON.parse((await env.ROWING_COURSES.get(kvKey)) ?? '[]') : [];
  const updatedLiked = [...new Set([...currentLiked, ...likedIds])];
  if (env.ROWING_COURSES) {
    await env.ROWING_COURSES.put(kvKey, JSON.stringify(updatedLiked));
  }

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
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/courses/index.json?ref=main`,
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
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/courses/${id}.json?ref=main`,
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
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/courses/${id}.json?ref=main`,
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
    return jsonResponse({ error: 'Missing file field' }, 400, true, request);
  }
  if (file.size > MAX_KML_UPLOAD_BYTES) {
    return jsonResponse({ error: 'KML file too large (max 1 MB)' }, 413, true, request);
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
    return jsonResponse({ error: 'Missing KML file' }, 400, true, request);
  }
  if (file.size > MAX_KML_UPLOAD_BYTES) {
    return jsonResponse({ error: 'KML file too large (max 1 MB)' }, 413, true, request);
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
    latlng: result.gateDiagnostics?.reason === 'no_gates' ? [] : result.valid ? latlngForMap : latlng.slice(0, len),
    ...(result.gateDiagnostics && { gateDiagnostics: result.gateDiagnostics }),
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
  env: Env,
  ctx?: ExecutionContext
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

  let priorCount = 0;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) as n FROM course_times WHERE course_id = ?')
      .bind(courseId)
      .first<{ n: number }>();
    priorCount = row?.n != null ? Number(row.n) : 0;
  } catch {
    priorCount = 0;
  }

  const courses = await getCourseIndex(env);
  const status = courseStatusById(courses, courseId);
  const notifyFirstMeasured = priorCount === 0 && status === 'provisional';

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

  if (ctx && notifyFirstMeasured) {
    const courseName = courseNameById(courses, courseId);
    ctx.waitUntil(notifyAdminsProvisionalCourseFirstMeasuredTime(env, { courseId, courseName, athleteId }));
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
  if (env.ROWING_COURSES) {
    const cached = await env.ROWING_COURSES.get(REMOVED_CHALLENGES_CACHE_KEY);
    if (cached) {
      try {
        const arr = JSON.parse(cached) as unknown;
        return new Set(Array.isArray(arr) ? arr.map(String) : []);
      } catch {
        // fall through
      }
    }
  }
  const res = await fetch(`${COURSES_BASE}/courses/removed-challenges.json`);
  if (!res.ok) return new Set();
  try {
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr)) return new Set();
    const ids = arr.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'id' in item) return String(item.id);
      return String(item);
    });
    if (env.ROWING_COURSES) {
      await env.ROWING_COURSES.put(REMOVED_CHALLENGES_CACHE_KEY, JSON.stringify(ids), {
        expirationTtl: REMOVED_CHALLENGES_CACHE_TTL,
      });
    }
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function getCourseIndex(env: Env): Promise<Array<{ id: string; name?: string; center_lat?: number; center_lon?: number; distance_m?: number }>> {
  if (env.ROWING_COURSES) {
    const cached = await env.ROWING_COURSES.get(COURSE_INDEX_CACHE_KEY);
    if (cached) {
      try {
        const arr = JSON.parse(cached) as unknown;
        return Array.isArray(arr) ? arr : [];
      } catch {
        // fall through
      }
    }
  }
  const res = await fetch(`${COURSES_BASE}/courses/index.json`);
  if (!res.ok) return [];
  try {
    const arr = (await res.json()) as unknown;
    const courses = Array.isArray(arr) ? arr : [];
    if (env.ROWING_COURSES) {
      await env.ROWING_COURSES.put(COURSE_INDEX_CACHE_KEY, JSON.stringify(courses), {
        expirationTtl: COURSE_INDEX_CACHE_TTL,
      });
    }
    return courses;
  } catch {
    return [];
  }
}

function courseNameById(courses: Array<{ id: string; name?: string }>, id: string): string {
  const c = courses.find((x) => String(x.id) === String(id));
  return c?.name ?? `Course ${id}`;
}

function courseStatusById(courses: Array<{ id: string; status?: string }>, id: string): 'provisional' | 'established' | null {
  const c = courses.find((x) => String(x.id) === String(id));
  const s = c?.status;
  if (s === 'provisional' || s === 'established') return s;
  return null;
}

/** Course index row (GitHub `courses/index.json`) — used for map preview and distance on challenge cards. */
function courseIndexFields(
  courses: Array<{ id: string; name?: string; center_lat?: number; center_lon?: number; distance_m?: number }>,
  courseId: string,
): { center_lat?: number; center_lon?: number; distance_m?: number } {
  const c = courses.find((x) => String(x.id) === String(courseId));
  if (!c) return {};
  const out: { center_lat?: number; center_lon?: number; distance_m?: number } = {};
  if (typeof c.center_lat === 'number') out.center_lat = c.center_lat;
  if (typeof c.center_lon === 'number') out.center_lon = c.center_lon;
  if (typeof c.distance_m === 'number') out.distance_m = c.distance_m;
  return out;
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

function challengeToApi(row: Record<string, unknown>, courses: Array<{ id: string; name?: string; center_lat?: number; center_lon?: number; distance_m?: number }>, collectionNames: Map<string, string>): Record<string, unknown> {
  const courseId = String(row.course_id ?? '');
  const collectionId = row.collection_id ? String(row.collection_id) : null;
  const courseFields = courseIndexFields(courses, courseId);
  const rawOrgName = row.organizer_name;
  const organizerName =
    rawOrgName != null && String(rawOrgName).trim() !== '' ? String(rawOrgName).trim() : null;
  return {
    id: row.id,
    name: row.name,
    courseId,
    courseName: courseNameById(courses, courseId),
    center_lat: courseFields.center_lat,
    center_lon: courseFields.center_lon,
    distance_m: courseFields.distance_m,
    rowStart: row.row_start,
    rowEnd: row.row_end,
    submitEnd: row.submit_end,
    collectionId,
    collectionName: collectionNameById(collectionId, collectionNames),
    hasHandicap: !!collectionId,
    organizerId: row.organizer_id,
    organizerName,
    resultsCount: row.results_count ?? 0,
    isPublic: (row.is_public ?? 1) !== 0,
    notes: row.notes ?? null,
  };
}

function challengeDetailToApi(row: Record<string, unknown>, courses: Array<{ id: string; name?: string; center_lat?: number; center_lon?: number; distance_m?: number }>, collectionNames: Map<string, string>): Record<string, unknown> {
  return challengeToApi(row, courses, collectionNames);
}

async function handleListChallenges(status: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  const courses = await getCourseIndex(env);
  try {
    const r = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM challenge_results cr WHERE cr.challenge_id = c.id AND cr.validation_status IN ('valid', 'manual_ok')) as results_count
       FROM challenges c
       WHERE c.is_public = 1 AND c.is_deleted = 0
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
      'SELECT * FROM challenges WHERE id = ? AND is_public = 1 AND (is_deleted = 0 OR is_deleted IS NULL)'
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
  const removed = await getRemovedChallengeIds(env);
  try {
    const r = await env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM challenge_results cr WHERE cr.challenge_id = c.id AND cr.validation_status IN ('valid', 'manual_ok')) as results_count
       FROM challenges c
       WHERE c.organizer_id = ? AND c.is_deleted = 0
       ORDER BY c.created_at DESC`
    )
      .bind(athleteId)
      .all();
    const rows = (r.results ?? []) as Record<string, unknown>[];
    const courses = await getCourseIndex(env);
    const customColls = await loadCollectionNames(env);
    const filtered = rows.filter((row) => !removed.has(String(row.id ?? '')));
    const api = filtered.map((row) => challengeToApi(row, courses, customColls));
    return jsonResponse({ challenges: api }, 200, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error';
    return jsonResponse({ error: msg }, 500, true);
  }
}

async function handleCreateChallenge(request: Request, athleteId: string, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true, request);
    let body: { name?: string; courseId?: string; rowStart?: string; rowEnd?: string; submitEnd?: string; collectionId?: string; notes?: string; isPublic?: boolean };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, true, request);
    }
    const name = body.name?.trim();
    const courseId = body.courseId ? String(body.courseId) : null;
    const rowStart = body.rowStart ? String(body.rowStart).slice(0, 19) : null;
    const rowEnd = body.rowEnd ? String(body.rowEnd).slice(0, 19) : null;
    const submitEnd = body.submitEnd ? String(body.submitEnd).slice(0, 19) : null;
    if (!name || !courseId || !rowStart || !rowEnd || !submitEnd) {
      return jsonResponse({ error: 'name, courseId, rowStart, rowEnd, submitEnd required' }, 400, true, request);
    }
    const rs = new Date(rowStart);
    const re = new Date(rowEnd);
    const se = new Date(submitEnd);
    if (Number.isNaN(rs.getTime()) || Number.isNaN(re.getTime()) || Number.isNaN(se.getTime())) {
      return jsonResponse({ error: 'Invalid rowStart, rowEnd, or submitEnd datetime' }, 400, true, request);
    }
    if (re <= rs) {
      return jsonResponse({ error: 'rowEnd must be after rowStart' }, 400, true, request);
    }
    if (se < re) {
      return jsonResponse({ error: 'submitEnd must be on or after rowEnd' }, 400, true, request);
    }
    const nameCheck = isNameAllowed(name);
    if (!nameCheck.allowed) {
      return jsonResponse({ error: nameCheck.reason ?? "That name isn't allowed." }, 400, true, request);
    }
    const collectionId = body.collectionId ? String(body.collectionId).trim() || null : null;
    const notes = body.notes?.trim() || null;
    const isPublic = body.isPublic !== false ? 1 : 0;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const session = await getSessionFromRequest(request, env);
    let organizerName: string | null = null;
    if (session?.accessToken) {
      const profile = await fetchIntervalsAthleteProfile(session.accessToken, athleteId);
      organizerName =
        profile?.name?.trim() ||
        [profile?.first_name, profile?.last_name]
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .join(' ') ||
        session.oauthAthleteName?.trim() ||
        null;
    }
    try {
      await env.DB.prepare(
        `INSERT INTO challenges (id, name, course_id, row_start, row_end, submit_end, collection_id, organizer_id, organizer_name, is_public, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          name,
          courseId,
          rowStart,
          rowEnd,
          submitEnd,
          collectionId,
          athleteId,
          organizerName,
          isPublic,
          notes,
          createdAt
        )
        .run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Database error';
      return jsonResponse({ error: msg }, 500, true, request);
    }
    const courses = await getCourseIndex(env);
    const customColls = await loadCollectionNames(env);
    const challenge = challengeToApi(
      {
        id,
        name,
        course_id: courseId,
        row_start: rowStart,
        row_end: rowEnd,
        submit_end: submitEnd,
        collection_id: collectionId,
        organizer_id: athleteId,
        organizer_name: organizerName,
        is_public: isPublic,
        notes,
        results_count: 0,
      },
      courses,
      customColls
    );

    if (ctx) {
      const courseIsProvisional = courseStatusById(courses, courseId) === 'provisional';
      ctx.waitUntil(
        notifyAdminsNewChallenge(env, {
          id,
          name,
          courseId,
          rowStart,
          rowEnd,
          submitEnd,
          athleteId,
          courseIsProvisional,
        })
      );
    }

    return jsonResponse({ id, challenge }, 200, true, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: msg }, 500, true, request);
  }
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

/** Map Rowsandall CSV gender to M/F/X: Open->M, Female->F, mixed->X */
function mapCsvSex(val: string): string {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'female') return 'F';
  if (v === 'mixed') return 'X';
  if (v === 'open') return 'M';
  return (v.slice(0, 1).toUpperCase() || 'M') as string;
}

/** Map Rowsandall CSV weight class: open-weight -> HWT, lightweight -> LWT */
function mapCsvWeightClass(val: string): string {
  const v = String(val || '').trim().toLowerCase();
  if (v === 'open-weight' || v === 'openweight') return 'HWT';
  if (v === 'lightweight' || v === 'lwt') return 'LWT';
  return v ? v.toUpperCase().slice(0, 3) : 'HWT';
}

/** Parse age from CSV cell (integer or null) */
function parseCsvAge(val: string): number | null {
  const n = parseInt(String(val || '').trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
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
    const sexIdx = cols.findIndex((c) => c === 'sex' || c === 'gender');
    const wcIdx = cols.findIndex((c) => c.includes('weight') || c === 'weightclass');
    const timeIdx = cols.findIndex((c) => c.includes('coursetime') || c.includes('standard') || c === 'time');
    const distIdx = cols.findIndex((c) => c.includes('coursedistance') || c === 'distance');
    const ageMinIdx = cols.findIndex((c) => c === 'agemin' || c === 'ageminimum' || c === 'minimum age' || (c.includes('age') && c.includes('min')));
    const ageMaxIdx = cols.findIndex((c) => c === 'agemax' || c === 'agemaximum' || c === 'maximum age' || (c.includes('age') && c.includes('max')));
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(/[,\t]/).map((c) => c.trim());
      const boatType = (boatIdx >= 0 ? cells[boatIdx] : '1x') || '1x';
      const sexRaw = (sexIdx >= 0 ? cells[sexIdx] : 'M') || 'M';
      const sex = mapCsvSex(sexRaw);
      const wcRaw = (wcIdx >= 0 ? cells[wcIdx] : 'HWT') || 'HWT';
      const weightClass = mapCsvWeightClass(wcRaw);
      const timeS = parseStandardTime(timeIdx >= 0 ? cells[timeIdx] : '');
      const distM = distIdx >= 0 ? parseFloat(cells[distIdx] || '') : NaN;
      const courseDistanceM = Number.isFinite(distM) && distM > 0 ? distM : 500;
      const ageMin = ageMinIdx >= 0 ? parseCsvAge(cells[ageMinIdx]) : -1;
      const ageMax = ageMaxIdx >= 0 ? parseCsvAge(cells[ageMaxIdx]) : 999;
      const ageMinVal = ageMin != null && ageMin >= 0 ? ageMin : -1;
      const ageMaxVal = ageMax != null && ageMax >= 0 ? ageMax : 999;
      if (timeS != null && timeS > 0) {
        try {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO course_standards (collection_id, boat_type, sex, weight_class, age_min, age_max, course_distance_m, standard_time_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
            .bind(id, boatType, sex, weightClass, ageMinVal, ageMaxVal, courseDistanceM, timeS)
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
      let validationLog: string[] | null = null;
      if (row.validation_log) {
        try {
          const parsed = JSON.parse(String(row.validation_log));
          validationLog = Array.isArray(parsed) ? parsed : null;
        } catch {
          // ignore
        }
      }
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
        validationLog,
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

async function handleDeleteChallenge(
  request: Request,
  challengeId: string,
  athleteId: string,
  env: Env
): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);

  const chRow = await env.DB.prepare('SELECT organizer_id, name FROM challenges WHERE id = ?')
    .bind(challengeId)
    .first();
  if (!chRow) return jsonResponse({ error: 'Challenge not found' }, 404, true);
  const challenge = chRow as { organizer_id: string; name: string };
  if (challenge.organizer_id !== athleteId) {
    return jsonResponse({ error: 'Not your challenge' }, 403, true);
  }

  const url = new URL(request.url);
  const mergeInto = url.searchParams.get('mergeInto');

  if (mergeInto) {
    const targetRow = await env.DB.prepare('SELECT organizer_id, name FROM challenges WHERE id = ?')
      .bind(mergeInto)
      .first();
    if (!targetRow) return jsonResponse({ error: 'Target challenge not found' }, 404, true);
    const target = targetRow as { organizer_id: string; name: string };
    if (target.organizer_id !== athleteId) {
      return jsonResponse({ error: 'Target challenge not yours' }, 403, true);
    }

    const resultsRow = await env.DB.prepare('SELECT COUNT(*) as count FROM challenge_results WHERE challenge_id = ?')
      .bind(challengeId)
      .first();
    const resultsCount = resultsRow ? Number((resultsRow as { count: number }).count) : 0;

    if (resultsCount > 0) {
      try {
        await env.DB.prepare(`
          INSERT INTO challenge_results (
            id, challenge_id, athlete_id, activity_id, display_name, 
            raw_time_s, corrected_time_s, points, category_key, 
            boat_type, sex, weight_class, crew_avg_age, 
            start_time, validation_status, validation_note, 
            validation_log, track_latlng, submitted_at
          )
          SELECT 
            id, ?, athlete_id, activity_id, display_name,
            raw_time_s, corrected_time_s, points, 
            REPLACE(category_key, ?, ?) as category_key,
            boat_type, sex, weight_class, crew_avg_age,
            start_time, validation_status, validation_note,
            validation_log, track_latlng, submitted_at
          FROM challenge_results
          WHERE challenge_id = ?
          ON CONFLICT(challenge_id, athlete_id, category_key) DO UPDATE SET
            raw_time_s = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.raw_time_s ELSE challenge_results.raw_time_s END,
            corrected_time_s = CASE WHEN excluded.corrected_time_s < challenge_results.corrected_time_s THEN excluded.corrected_time_s ELSE challenge_results.corrected_time_s END,
            activity_id = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.activity_id ELSE challenge_results.activity_id END,
            start_time = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.start_time ELSE challenge_results.start_time END,
            submitted_at = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.submitted_at ELSE challenge_results.submitted_at END,
            track_latlng = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.track_latlng ELSE challenge_results.track_latlng END,
            validation_log = CASE WHEN excluded.raw_time_s < challenge_results.raw_time_s THEN excluded.validation_log ELSE challenge_results.validation_log END
        `).bind(mergeInto, challengeId, mergeInto, challengeId).run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Database error during merge';
        return jsonResponse({ error: msg }, 500, true);
      }
    }
  }

  try {
    await env.DB.prepare('UPDATE challenges SET is_deleted = 1 WHERE id = ?')
      .bind(challengeId)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Database error marking challenge as deleted';
    return jsonResponse({ error: msg }, 500, true);
  }

  const removedIssue = await addToRemovedChallenges(env, challengeId, athleteId, challenge.name, mergeInto);

  return jsonResponse({
    success: true,
    challengeId,
    mergedInto: mergeInto || null,
    issue: removedIssue,
  }, 200, true);
}

async function addToRemovedChallenges(
  env: Env,
  challengeId: string,
  organizerId: string,
  challengeName: string,
  mergedInto?: string | null
): Promise<string | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;

  try {
    const repo = env.GITHUB_REPO;
    const [owner, repoName] = repo.split('/');
    const path = 'courses/removed-challenges.json';
    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-Worker',
    };

    const getRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}`, { headers });
    let sha: string | null = null;
    let existingData: Array<{ id: string; removedBy: string; removedAt: string; reason?: string }> = [];

    if (getRes.ok) {
      const json = (await getRes.json()) as { content: string; sha: string };
      sha = json.sha;
      const content = atob(json.content.replace(/\s/g, ''));
      existingData = JSON.parse(content);
    }

    existingData.push({
      id: challengeId,
      removedBy: organizerId,
      removedAt: new Date().toISOString(),
      reason: mergedInto ? `Merged into ${mergedInto}` : 'Removed by organizer',
    });

    const newContent = JSON.stringify(existingData, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(newContent)));

    const reason = mergedInto ? `Merged duplicate challenge into ${mergedInto}` : 'Removed duplicate/incorrect challenge';
    const issueTitle = `Challenge removed: ${challengeName}`;
    const issueBody = `Challenge ID: ${challengeId}\nOrganizer: ${organizerId}\nReason: ${reason}`;

    const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
        labels: ['challenge-removal'],
      }),
    });

    if (!issueRes.ok) {
      throw new Error(`Failed to create issue: ${issueRes.status}`);
    }

    const issue = (await issueRes.json()) as { number: number; html_url: string };

    const commitMessage = `Remove challenge ${challengeId}${mergedInto ? ` (merged into ${mergedInto})` : ''}\n\nSee issue #${issue.number}`;

    const putRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMessage,
        content: encoded,
        sha,
        branch: 'main',
      }),
    });

    if (!putRes.ok) {
      throw new Error(`Failed to update removed-challenges.json: ${putRes.status}`);
    }

    const updatedIds = existingData.map((x) => x.id);
    if (env.ROWING_COURSES) {
      await env.ROWING_COURSES.put(REMOVED_CHALLENGES_CACHE_KEY, JSON.stringify(updatedIds), {
        expirationTtl: REMOVED_CHALLENGES_CACHE_TTL,
      });
    }

    return issue.html_url;
  } catch (e) {
    console.error('Failed to update removed-challenges.json:', e);
    return null;
  }
}

async function handleChallengeResults(challengeId: string, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 500, true);
  const removed = await getRemovedChallengeIds(env);
  if (removed.has(challengeId)) return jsonResponse({ error: 'Not found' }, 404, true);
  let chRow = null;
  try {
    chRow = await env.DB.prepare('SELECT collection_id, is_deleted FROM challenges WHERE id = ?').bind(challengeId).first();
    if (chRow && (chRow as { is_deleted?: number }).is_deleted === 1) {
      return jsonResponse({ error: 'Not found' }, 404, true);
    }
  } catch {
    // Column may not exist in test DB, fetch without is_deleted check
    chRow = await env.DB.prepare('SELECT collection_id FROM challenges WHERE id = ?').bind(challengeId).first();
  }
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
  const submitUrl = new URL(request.url);
  const debugSubmit = submitUrl.searchParams.get('debug') === '1';
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
    'SELECT * FROM challenges WHERE id = ? AND is_public = 1 AND is_deleted = 0'
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

  let intervalsMeta: IntervalsAthleteSelfMeta | undefined;
  let displayName: string | null = body.displayName?.trim() || null;
  if (!displayName) {
    const { profile, meta } = await fetchIntervalsAthleteProfileWithMeta(session.accessToken, athleteId);
    intervalsMeta = meta;
    if (profile) {
      const fromParts = [profile.first_name, profile.last_name]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .join(' ');
      displayName = profile.name?.trim() || fromParts || null;
    }
    if (!displayName && session.oauthAthleteName?.trim()) {
      displayName = session.oauthAthleteName.trim();
    }
  } else if (debugSubmit) {
    const { meta } = await fetchIntervalsAthleteProfileWithMeta(session.accessToken, athleteId);
    intervalsMeta = meta;
  }
  if (displayName) {
    const displayCheck = isNameAllowed(displayName);
    if (!displayCheck.allowed) {
      return jsonResponse({
        error: displayCheck.reason ?? "That name isn't allowed.",
        ...(debugSubmit ? {
          _debug: {
            intervalsAthleteSelf: intervalsMeta,
            displayNameRejected: displayName,
          },
        } : {}),
      }, 400, true);
    }
  }
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
  
  // Category key: boat|display_name|sex|weight for unique result per athlete per category
  // Includes boat_type and display_name even for non-handicap challenges so different crews/boats don't overwrite each other
  const normalizedDisplayName = (displayName || '').trim().toLowerCase();
  let categoryKey = (boatType || '') + '|' + normalizedDisplayName + '|' + (sex || '') + '|' + (weightClass || '');
  let correctedTimeS = result.timeS;
  let points: number | null = null;
  if (collectionId && boatType && sex) {
    const builtin = ['hocr', 'fisa', 'charles'];
    if (!builtin.includes(collectionId.toLowerCase()) && env.DB) {
      const ageAgnostic = await env.DB.prepare(
        'SELECT 1 FROM course_standards WHERE collection_id = ? AND age_min = -1 AND age_max = 999 LIMIT 1'
      )
        .bind(collectionId)
        .first();
      if (!ageAgnostic && crewAvgAge == null) {
        return jsonResponse({ error: 'crewAvgAge required for this handicap collection' }, 400, true);
      }
    }
    const courseDistanceM = (typeof course.distance_m === 'number' && course.distance_m > 0 ? course.distance_m : result.distanceM) || undefined;
    const handicap = await computeHandicap(
      collectionId,
      { rawTimeS: result.timeS, boatType, sex, weightClass: weightClass ?? undefined, courseDistanceM, crewAvgAge: crewAvgAge ?? undefined },
      env.DB
    );
    if (handicap) {
      correctedTimeS = handicap.correctedTimeS;
      points = handicap.points;
      if (handicap.ageBand) {
        categoryKey = (boatType || '') + '|' + normalizedDisplayName + '|' + (sex || '') + '|' + (weightClass || '') + '|' + handicap.ageBand;
      }
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

    const validationLogJson = JSON.stringify(validationLog);
    await env.DB.prepare(
      `INSERT INTO challenge_results (id, challenge_id, athlete_id, activity_id, display_name, raw_time_s, corrected_time_s, points, boat_type, sex, weight_class, crew_avg_age, start_time, validation_status, validation_note, validation_log, track_latlng, submitted_at, category_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?)
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
         validation_log = excluded.validation_log,
         track_latlng = excluded.track_latlng,
         submitted_at = excluded.submitted_at`
    )
      .bind(id, challengeId, athleteId, activityId, displayName, result.timeS, correctedTimeS, points, boatType, sex, weightClass, crewAvgAge, startTime, validationNote, validationLogJson, trackLatlng, submittedAt, categoryKey)
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
    ...(debugSubmit ? {
      _debug: {
        displayNameStored: displayName,
        displayNameFromBody: body.displayName?.trim() || null,
        intervalsAthleteSelf: intervalsMeta,
        athleteId,
        challengeId,
        categoryKey,
      },
    } : {}),
  }, 200, true);
}

type OpenCoursePRResult = { ok: true; prUrl: string } | { ok: false; error: string };

async function openCoursePR(
  env: Env,
  courseJson: CourseFromKml,
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

  const mainRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/heads/main`, {
    headers,
  });
  if (!mainRes.ok) return { ok: false, error: await githubApiError(mainRes) };

  const mainRef = (await mainRes.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  const createBranchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if (!createBranchRes.ok) return { ok: false, error: await githubApiError(createBranchRes) };

  const courseJsonStr = JSON.stringify(courseJson, null, 2);
  const courseB64 = uint8ToBase64(new TextEncoder().encode(courseJsonStr));
  const kmlB64 = uint8ToBase64(new TextEncoder().encode(kmlContent));

  const putJson = await fetch(
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/courses/${id}.json`,
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
  if (!putJson.ok) return { ok: false, error: await githubApiError(putJson) };

  const putKml = await fetch(
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/kml/${id}.kml`,
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
  if (!putKml.ok) return { ok: false, error: await githubApiError(putKml) };

  const prRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/pulls`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      head: branchName,
      base: 'main',
      body,
    }),
  });
  if (!prRes.ok) return { ok: false, error: await githubApiError(prRes) };
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

  const mainRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/heads/main`, {
    headers,
  });
  if (!mainRes.ok) return { ok: false, error: await githubApiError(mainRes) };

  const mainRef = (await mainRes.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  const createBranchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if (!createBranchRes.ok) return { ok: false, error: await githubApiError(createBranchRes) };

  const courseJsonStr = JSON.stringify(courseJson, null, 2);
  const courseB64 = uint8ToBase64(new TextEncoder().encode(courseJsonStr));

  const putJson = await fetch(
    `${GITHUB_API}/repos/${owner}/${repoName}/contents/courses/${id}.json`,
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
  if (!putJson.ok) return { ok: false, error: await githubApiError(putJson) };

  const prRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/pulls`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Update course ${id} from KML revision`,
      head: branchName,
      base: 'main',
      body: `Revised geometry via rownative.icu. Course: ${courseName}`,
    }),
  });
  if (!prRes.ok) return { ok: false, error: await githubApiError(prRes) };
  const pr = (await prRes.json()) as { html_url?: string };
  const prUrl = pr.html_url ?? null;
  return prUrl ? { ok: true, prUrl } : { ok: false, error: 'GitHub did not return PR URL' };
}
