const COURSES_BASE = 'https://raw.githubusercontent.com/rownative/courses/main';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Course index
    if (path === '/api/courses/' || path === '/api/courses') {
      return fetchFromGitHub(`${COURSES_BASE}/courses/index.json`, 'application/json');
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

    // Follow / unfollow
    const followMatch = path.match(/^\/rowers\/courses\/(\d+)\/(follow|unfollow)\/?$/);
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

    // GET /api/me
    if (path === '/api/me' || path === '/api/me/') {
      const athleteId = await getAthleteIdFromRequest(request, env);
      if (!athleteId) return new Response('Unauthorised', { status: 401 });
      const liked: string[] = JSON.parse((await env.ROWING_COURSES.get(`liked:${athleteId}`)) ?? '[]');
      return new Response(JSON.stringify({ athleteId, liked }), {
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
  // Cookie auth (browser) — placeholder until OAuth is implemented
  return null;
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