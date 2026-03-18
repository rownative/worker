import { unzipSync } from 'fflate';
import { kmlToCourse, haversine } from './kml-to-course';

// Rowing courses API
const COURSES_BASE = 'https://raw.githubusercontent.com/rownative/courses/main';
const GITHUB_API = 'https://api.github.com';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

      return new Response(JSON.stringify(filtered), {
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
      const payload = athleteId
        ? { athleteId, liked: JSON.parse((await env.ROWING_COURSES.get(`liked:${athleteId}`)) ?? '[]') }
        : { athleteId: null, liked: [] };
      return new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://rownative.icu',
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

    // OAuth login — redirect to intervals.icu (with state for CSRF protection)
    if (path === '/oauth/authorize') {
      const state = crypto.randomUUID();
      console.log(`[oauth] authorize: generated state=${state}`);
      const params = new URLSearchParams({
        client_id: env.INTERVALS_CLIENT_ID,
        redirect_uri: 'https://rownative.icu/oauth/callback',
        response_type: 'code',
        scope: 'ACTIVITY:READ',
        state,
      });
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `https://intervals.icu/oauth/authorize?${params}`,
          'Set-Cookie': `rn_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
        },
      });
    }

    // OAuth callback — exchange code for tokens
    if (path === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Verify state (CSRF protection)
      const cookieHeader = request.headers.get('Cookie') ?? '';
      const stateMatch = cookieHeader.match(/rn_oauth_state=([^;]+)/);
      const storedState = stateMatch ? stateMatch[1].trim() : null;
      console.log(`[oauth] callback: code present=${!!code}, state from URL=${state}`);
      console.log(`[oauth] callback: cookie header present=${cookieHeader.length > 0}, stored state=${storedState}`);
      console.log(`[oauth] callback: state match=${!!state && !!storedState && state === storedState}`);
      if (!code || !state || !storedState || state !== storedState) {
        const reason = !code ? 'Missing code' : 'Invalid state';
        console.log(`[oauth] callback: validation failed — ${reason}`);
        return new Response(reason, { status: 400 });
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
          redirect_uri: 'https://rownative.icu/oauth/callback',
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
      const headers = new Headers({ 'Location': '/' });
      headers.append('Set-Cookie', `rn_session=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`);
      headers.append('Set-Cookie', 'rn_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');

      return new Response(null, { status: 302, headers });
    }

    // OAuth logout
    if (path === '/oauth/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': 'rn_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
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

  // Cookie auth (browser)
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const match = cookieHeader.match(/rn_session=([^;]+)/);
  if (!match) return null;
  const session = await decryptSession(match[1], env.TOKEN_ENCRYPTION_KEY);
  if (!session) return null;

  return session.athleteId;
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://rownative.icu',
  'Access-Control-Allow-Credentials': 'true',
};

function jsonResponse(body: object, status: number, withCors = false): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withCors) Object.assign(headers, CORS_HEADERS);
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
