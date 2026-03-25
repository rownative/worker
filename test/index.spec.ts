import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Rowing Courses Worker', () => {
	async function fetchAndWait(url: string, init?: RequestInit) {
		const request = new IncomingRequest(url, init);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it('returns 404 for unknown paths', async () => {
		const response = await fetchAndWait('https://rownative.icu/unknown');
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not found');
	});

	it('returns 404 for unknown API paths', async () => {
		const response = await fetchAndWait('https://rownative.icu/api/foo');
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not found');
	});

	it('GET /api/me returns JSON with athleteId null when not authenticated', async () => {
		const response = await fetchAndWait('https://rownative.icu/api/me');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const data = await response.json();
		expect(data).toEqual({ athleteId: null, liked: [] });
	});

	it('GET /api/courses/kml without ids returns 400', async () => {
		const response = await fetchAndWait('https://rownative.icu/api/courses/kml');
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Missing ids parameter');
	});

	it('GET /api/courses/kml with empty ids returns 400', async () => {
		const response = await fetchAndWait('https://rownative.icu/api/courses/kml?ids=');
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Missing ids parameter');
	});

	it('SELF fetch for /api/me returns JSON (integration style)', async () => {
		const response = await SELF.fetch('https://rownative.icu/api/me');
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toHaveProperty('athleteId');
		expect(data).toHaveProperty('liked');
	});

	describe('GET /api/courses', () => {
		it('returns full index when no geo params', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses');
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('application/json');
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(data[0]).toHaveProperty('id');
			expect(data[0]).toHaveProperty('center_lat');
			expect(data[0]).toHaveProperty('center_lon');
		});

		it('returns filtered courses when lat, lon, radius provided', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/api/courses?lat=42&lon=-71&radius=50000',
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('application/json');
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
			// All returned courses should be within 50 km of (42, -71)
			const haversine = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
				const R = 6371000;
				const toRad = (d: number) => (d * Math.PI) / 180;
				const dLat = toRad(b.lat - a.lat);
				const dLon = toRad(b.lon - a.lon);
				const lat1 = toRad(a.lat);
				const lat2 = toRad(b.lat);
				const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
				return 2 * R * Math.asin(Math.sqrt(x));
			};
			const center = { lat: 42, lon: -71 };
			for (const c of data) {
				if (c.center_lat != null && c.center_lon != null) {
					expect(haversine(center, { lat: c.center_lat, lon: c.center_lon })).toBeLessThanOrEqual(50000);
				}
			}
		});
	});

	describe('OAuth flow', () => {
		it('GET /oauth/authorize redirects to intervals.icu with a state cookie', async () => {
			const response = await fetchAndWait('https://rownative.icu/oauth/authorize');
			expect(response.status).toBe(302);
			const location = response.headers.get('Location') ?? '';
			expect(location).toContain('https://intervals.icu/oauth/authorize');
			expect(location).toContain('state=');
			expect(location).toContain('response_type=code');
			const setCookie = response.headers.get('Set-Cookie') ?? '';
			expect(setCookie).toContain('rn_oauth_state=');
			expect(setCookie).toContain('HttpOnly');
			expect(setCookie).toContain('Secure');
			expect(setCookie).toContain('Max-Age=600');
		});

		it('GET /oauth/authorize state matches between cookie and redirect URL', async () => {
			const response = await fetchAndWait('https://rownative.icu/oauth/authorize');
			const location = response.headers.get('Location') ?? '';
			const setCookie = response.headers.get('Set-Cookie') ?? '';

			const urlState = new URL(location).searchParams.get('state');
			const cookieMatch = setCookie.match(/rn_oauth_state=([^;]+)/);
			const cookieState = cookieMatch ? cookieMatch[1] : null;

			expect(urlState).toBeTruthy();
			expect(cookieState).toBeTruthy();
			expect(urlState).toBe(cookieState);
		});

		it('GET /oauth/callback with missing code returns 400 Missing code', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/callback?state=test-state',
				{ headers: { 'Cookie': 'rn_oauth_state=test-state' } },
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Missing code');
		});

		it('GET /oauth/callback with missing state cookie returns 400 Invalid state', async () => {
			// state "test-state" was never stored (no prior authorize) — invalid
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/callback?code=test-code&state=test-state',
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state');
		});

		it('GET /oauth/callback with no cookie but state in KV (iOS fallback) passes validation', async () => {
			// Simulate iOS: authorize stores state in KV; callback has no cookie but state in URL
			const authRes = await fetchAndWait('https://rownative.icu/oauth/authorize');
			const location = authRes.headers.get('Location') ?? '';
			const urlState = new URL(location).searchParams.get('state');
			expect(urlState).toBeTruthy();
			// Callback without cookie — KV fallback should allow state validation to pass
			const response = await fetchAndWait(
				`https://rownative.icu/oauth/callback?code=fake-code&state=${urlState}`,
			);
			// State validation passes; token exchange fails (fake code) → 500, not 400 Invalid state
			expect(response.status).toBe(500);
			expect(await response.text()).toContain('Token exchange failed');
		});

		it('GET /oauth/callback with mismatched state returns 400 Invalid state', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/callback?code=test-code&state=different-state',
				{ headers: { 'Cookie': 'rn_oauth_state=test-state' } },
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state');
		});

		it('GET /oauth/callback with missing state param returns 400 Invalid state', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/callback?code=test-code',
				{ headers: { 'Cookie': 'rn_oauth_state=test-state' } },
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state');
		});

		it('GET /oauth/logout redirects to / and clears the session cookie', async () => {
			const response = await fetchAndWait('https://rownative.icu/oauth/logout');
			expect(response.status).toBe(302);
			expect(response.headers.get('Location')).toBe('/');
			const setCookie = response.headers.get('Set-Cookie') ?? '';
			expect(setCookie).toContain('rn_session=');
			expect(setCookie).toContain('Max-Age=0');
		});
	});

	describe('Phase 2a — Course times', () => {
		it('GET /api/me/activities returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/me/activities');
			expect(response.status).toBe(401);
		});

		it('POST /api/courses/66/calculate-time returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses/66/calculate-time', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ activityId: '123' }),
			});
			expect(response.status).toBe(401);
		});

		it('GET /api/me/course-times returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/me/course-times');
			expect(response.status).toBe(401);
		});
	});

	describe('CORS origin validation', () => {
		it('OPTIONS preflight with legitimate localhost origin is reflected', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses', {
				method: 'OPTIONS',
				headers: { 'Origin': 'http://localhost:3000' },
			});
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
		});

		it('OPTIONS preflight with legitimate 127.0.0.1 origin is reflected', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses', {
				method: 'OPTIONS',
				headers: { 'Origin': 'http://127.0.0.1:8080' },
			});
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:8080');
		});

		it('OPTIONS preflight with evil-localhost.com origin is NOT reflected', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses', {
				method: 'OPTIONS',
				headers: { 'Origin': 'https://evil-localhost.com' },
			});
			// Should fall back to the production origin, not the malicious one
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://rownative.icu');
		});

		it('OPTIONS preflight with non-localhost production origin falls back to rownative.icu', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses', {
				method: 'OPTIONS',
				headers: { 'Origin': 'https://attacker.com' },
			});
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://rownative.icu');
		});
	});

	describe('Open redirect protection', () => {
		it('GET /oauth/authorize with non-localhost return_to is silently ignored', async () => {
			// The state stored in KV should not contain the external URL
			const authResponse = await fetchAndWait(
				'https://rownative.icu/oauth/authorize?local=1&return_to=https://evil.com/steal',
				{ headers: { 'Host': 'localhost:8787' } },
			);
			expect(authResponse.status).toBe(302);
			// Obtain the state so we can read what was stored in KV
			const location = authResponse.headers.get('Location') ?? '';
			const urlState = new URL(location).searchParams.get('state') ?? '';
			// Read the KV value — it should be 'local' (no return_to) rather than 'local:https://evil.com/steal'
			const kvVal = await env.ROWING_COURSES.get(`oauth_state:${urlState}`);
			expect(kvVal).toBe('local');
			expect(kvVal).not.toContain('evil.com');
		});

		it('GET /oauth/authorize with localhost return_to is stored in KV', async () => {
			const authResponse = await fetchAndWait(
				'https://rownative.icu/oauth/authorize?local=1&return_to=http://localhost:8080/dashboard',
				{ headers: { 'Host': 'localhost:8787' } },
			);
			expect(authResponse.status).toBe(302);
			const location = authResponse.headers.get('Location') ?? '';
			const urlState = new URL(location).searchParams.get('state') ?? '';
			const kvVal = await env.ROWING_COURSES.get(`oauth_state:${urlState}`);
			expect(kvVal).toBe('local:http://localhost:8080/dashboard');
		});

		it('GET /oauth/logout with non-localhost return_to is ignored, redirects to default', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/logout?local=1&return_to=https://evil.com/steal',
				{ headers: { 'Host': 'localhost:8787' } },
			);
			expect(response.status).toBe(302);
			const location = response.headers.get('Location') ?? '';
			// Should redirect to the default localhost address, not to evil.com
			expect(location).not.toContain('evil.com');
			expect(location).toBe('http://localhost:8080/');
		});

		it('GET /oauth/logout with localhost return_to is honoured', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/logout?local=1&return_to=http://localhost:3000/home',
				{ headers: { 'Host': 'localhost:8787' } },
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('Location')).toBe('http://localhost:3000/home');
		});
	});

	describe('Upload size limits', () => {
		it('POST /api/courses/import-zip returns 401 without auth (size check comes after auth)', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses/import-zip', {
				method: 'POST',
				headers: { 'Content-Type': 'multipart/form-data; boundary=----boundary' },
				body: '------boundary\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\ndata\r\n------boundary--',
			});
			expect(response.status).toBe(401);
		});
	});
});
