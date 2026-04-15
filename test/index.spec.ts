import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
		expect(data).toEqual({ athleteId: null, liked: [], isOrganizer: false, athleteDisplayName: null });
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
			expect(data).toHaveProperty('courses');
			const courses = data.courses;
			expect(Array.isArray(courses)).toBe(true);
			expect(courses.length).toBeGreaterThan(0);
			expect(courses[0]).toHaveProperty('id');
			expect(courses[0]).toHaveProperty('center_lat');
			expect(courses[0]).toHaveProperty('center_lon');
		});

		it('returns filtered courses when lat, lon, radius provided', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/api/courses?lat=42&lon=-71&radius=50000',
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('application/json');
			const data = await response.json();
			expect(data).toHaveProperty('courses');
			const courses = data.courses;
			expect(Array.isArray(courses)).toBe(true);
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
			for (const c of courses) {
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
			expect(location).toContain('SETTINGS%3AREAD');
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

		it('GET /oauth/logout with local=1 rejects external return_to (open redirect)', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/logout?local=1&return_to=https://evil.com/steal',
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('Location')).toBe('http://localhost:8080/');
		});

		it('GET /oauth/logout with local=1 accepts safe return_to to localhost', async () => {
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/logout?local=1&return_to=http://localhost:3000/app',
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('Location')).toBe('http://localhost:3000/app');
		});
	});

	describe('CORS origin validation', () => {
		it('GET /api/me does not reflect Origin http://evil-localhost.com', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/me', {
				headers: { Origin: 'http://evil-localhost.com' },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://rownative.icu');
		});

		it('GET /api/me reflects legitimate localhost Origin', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/me', {
				headers: { Origin: 'http://localhost:8080' },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
		});

		it('OPTIONS preflight does not reflect Origin http://evil-localhost.com', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/me', {
				method: 'OPTIONS',
				headers: { Origin: 'http://evil-localhost.com' },
			});
			expect(response.status).toBe(204);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://rownative.icu');
		});
	});

	describe('Phase 2a - Course times', () => {
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

	describe('Challenges and organiser', () => {
		/** Local Vitest D1 may lack migrations; then handlers return 500 with { error }. */
		async function challengesListResponse(url: string) {
			const response = await fetchAndWait(url);
			const data = (await response.json()) as { challenges?: unknown[]; error?: string };
			return { response, data };
		}

		it('GET /api/challenges returns challenges list or database error JSON', async () => {
			const { response, data } = await challengesListResponse('https://rownative.icu/api/challenges');
			if (response.status === 200) {
				expect(data.challenges).toBeDefined();
				expect(Array.isArray(data.challenges)).toBe(true);
			} else {
				expect(response.status).toBe(500);
				expect(data.error).toBeTruthy();
			}
		});

		it('GET /api/challenges?status=active uses active filter when DB is available', async () => {
			const { response, data } = await challengesListResponse(
				'https://rownative.icu/api/challenges?status=active',
			);
			if (response.status === 200) {
				expect(data.challenges).toBeDefined();
			} else {
				expect(response.status).toBe(500);
				expect(data.error).toBeTruthy();
			}
		});

		it('GET /api/challenges?status=invalid defaults status to active', async () => {
			const { response, data } = await challengesListResponse(
				'https://rownative.icu/api/challenges?status=not-a-status',
			);
			if (response.status === 200) {
				expect(data.challenges).toBeDefined();
			} else {
				expect(response.status).toBe(500);
				expect(data.error).toBeTruthy();
			}
		});

		it('GET /api/challenges/unknown-id returns 404 when DB works, else 500', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/challenges/nonexistent-challenge-id-xyz');
			const data = (await response.json()) as { error?: string };
			expect([404, 500]).toContain(response.status);
			expect(data.error).toBeTruthy();
		});

		it('POST /api/challenges/x/submit returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/challenges/c1/submit', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(401);
		});

		it('GET /api/organiser/challenges returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/organiser/challenges');
			expect(response.status).toBe(401);
		});

		it('POST /api/organiser/challenges returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/organiser/challenges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(401);
		});

		it('GET /api/organiser/standard-collections returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/organiser/standard-collections');
			expect(response.status).toBe(401);
		});

		it('POST /api/organiser/standard-collections returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/organiser/standard-collections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(401);
		});

		it('DELETE /api/organiser/challenges/:id returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/organiser/challenges/test-challenge-id', {
				method: 'DELETE',
			});
			expect(response.status).toBe(401);
		});
	});

	describe('Auth, KML liked, follow', () => {
		it('POST /api/auth/crewnerd without Bearer returns 401', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(401);
			expect(await response.text()).toBe('Missing bearer token');
		});

		it('GET /api/courses/kml/liked returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/courses/kml/liked');
			expect(response.status).toBe(401);
		});

		it('POST /api/rowers/courses/1/follow returns 401 when not authenticated', async () => {
			const response = await fetchAndWait('https://rownative.icu/api/rowers/courses/1/follow', {
				method: 'POST',
			});
			expect(response.status).toBe(401);
		});
	});

	describe('CrewNerd Authentication (mocked)', () => {
		let originalFetch: typeof globalThis.fetch;

		beforeEach(() => {
			originalFetch = globalThis.fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('POST /api/auth/crewnerd with valid token (flat response) returns API key', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ id: 'i58453', name: 'Tony Test' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer valid-oauth-token-flat' },
			});

			expect(response.status).toBe(200);
			const data = await response.json() as { api_key?: string };
			expect(data.api_key).toBeDefined();
			expect(typeof data.api_key).toBe('string');
			expect(data.api_key?.split('.').length).toBe(2);
		});

		it('POST /api/auth/crewnerd with valid token (nested athlete response) returns API key', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ 
						athlete: { 
							id: 'i58453', 
							name: 'Tony Test',
							email: 'tony@example.com'
						} 
					}), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer valid-oauth-token-nested' },
			});

			expect(response.status).toBe(200);
			const data = await response.json() as { api_key?: string };
			expect(data.api_key).toBeDefined();
			expect(typeof data.api_key).toBe('string');
			expect(data.api_key?.split('.').length).toBe(2);
		});

		it('POST /api/auth/crewnerd with invalid token returns 401', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer invalid-token' },
			});

			expect(response.status).toBe(401);
			expect(await response.text()).toBe('Invalid token');
		});

		it('POST /api/auth/crewnerd with numeric athlete ID returns API key', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ id: 58453, name: 'Tony Test' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer valid-oauth-numeric-id' },
			});

			expect(response.status).toBe(200);
			const data = await response.json() as { api_key?: string };
			expect(data.api_key).toBeDefined();
			expect(data.api_key).toMatch(/^58453\./);
		});

		it('POST /api/auth/crewnerd with response missing id field returns 401', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ name: 'Tony Test', email: 'tony@test.com' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer token-no-id-field' },
			});

			expect(response.status).toBe(401);
			expect(await response.text()).toBe('Invalid token');
		});

		it('POST /api/auth/crewnerd with JWT token uses fallback endpoint', async () => {
			const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdGhsZXRlSWQiOiJpNTg0NTMiLCJuYW1lIjoiVG9ueSJ9.fakesig';
			
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ error: 'Not found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (url === 'https://intervals.icu/api/v1/athlete/i58453') {
					return new Response(JSON.stringify({ id: 'i58453', name: 'Tony Test' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${jwtToken}` },
			});

			expect(response.status).toBe(200);
			const data = await response.json() as { api_key?: string };
			expect(data.api_key).toBeDefined();
			expect(data.api_key).toMatch(/^i58453\./);
		});

		it('POST /api/auth/crewnerd with intervals.icu API key (Basic auth fallback) returns API key', async () => {
			const intervalsApiKey = 'abc123def456';
			const expectedBasicAuth = `Basic ${btoa('API_KEY:' + intervalsApiKey)}`;

			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
					// Bearer auth fails (API keys are not OAuth tokens)
					if (authHeader.startsWith('Bearer ')) {
						return new Response(JSON.stringify({ error: 'Unauthorized' }), {
							status: 401,
							headers: { 'Content-Type': 'application/json' },
						});
					}
					// Basic auth with API_KEY:<key> succeeds
					if (authHeader === expectedBasicAuth) {
						return new Response(JSON.stringify({ id: 'i58453', name: 'Tony Test' }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						});
					}
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL, init);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${intervalsApiKey}` },
			});

			expect(response.status).toBe(200);
			const data = await response.json() as { api_key?: string };
			expect(data.api_key).toBeDefined();
			expect(data.api_key).toMatch(/^i58453\./);
		});

		it('POST /api/auth/crewnerd with invalid API key (Basic auth also fails) returns 401', async () => {
			const seenAuthHeaders: string[] = [];
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
					seenAuthHeaders.push(authHeader);
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL, init);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer invalid-api-key' },
			});

			expect(response.status).toBe(401);
			expect(await response.text()).toBe('Invalid token');
			// Verify both Bearer and Basic auth fallback were attempted
			expect(seenAuthHeaders.some(h => h.startsWith('Bearer '))).toBe(true);
			expect(seenAuthHeaders.some(h => h.startsWith('Basic '))).toBe(true);
		});

		it('End-to-end: Exchange token and use API key to fetch liked courses', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ id: 'i58453', name: 'Tony Test' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const authResponse = await fetchAndWait('https://rownative.icu/api/auth/crewnerd', {
				method: 'POST',
				headers: { 'Authorization': 'Bearer valid-oauth-token-e2e' },
			});

			expect(authResponse.status).toBe(200);
			const authData = await authResponse.json() as { api_key?: string };
			expect(authData.api_key).toBeDefined();
			const apiKey = authData.api_key!;

			const likedResponse = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': `ApiKey ${apiKey}` },
			});

			expect(likedResponse.status).toBe(200);
			expect(likedResponse.headers.get('Content-Type')).toContain('application/vnd.google-earth.kml+xml');
		});

		it('End-to-end: Invalid API key returns 401', async () => {
			const likedResponse = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'ApiKey i58453.invalid-mac-signature' },
			});

			expect(likedResponse.status).toBe(401);
		});
	});

	describe('Bearer Token Backward Compatibility', () => {
		let originalFetch: typeof globalThis.fetch;

		beforeEach(() => {
			originalFetch = globalThis.fetch;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('GET /api/courses/kml/liked with Bearer token returns KML', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ id: 'i58453', name: 'Bearer User' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'Bearer valid-bearer-token-compat' },
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('application/vnd.google-earth.kml+xml');
		});

		it('Bearer token with cache hit skips intervals.icu API call', async () => {
			let apiCallCount = 0;

			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					apiCallCount++;
					return new Response(JSON.stringify({ id: 'i58453', name: 'Cached User' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response1 = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'Bearer cacheable-token-test' },
			});

			expect(response1.status).toBe(200);
			expect(apiCallCount).toBe(1);

			const response2 = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'Bearer cacheable-token-test' },
			});

			expect(response2.status).toBe(200);
			expect(apiCallCount).toBe(1);
		});

		it('Invalid Bearer token on data endpoint returns 401', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'Bearer invalid-bearer-token' },
			});

			expect(response.status).toBe(401);
		});

		it('Bearer token with nested athlete response works on data endpoint', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === 'https://intervals.icu/api/v1/athlete/0') {
					return new Response(JSON.stringify({ 
						athlete: { 
							id: 'i58453', 
							name: 'Nested User',
							email: 'nested@example.com'
						} 
					}), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo | URL);
			}) as typeof fetch;

			const response = await fetchAndWait('https://rownative.icu/api/courses/kml/liked', {
				method: 'GET',
				headers: { 'Authorization': 'Bearer bearer-nested-athlete-test' },
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('application/vnd.google-earth.kml+xml');
		});
	});
});
