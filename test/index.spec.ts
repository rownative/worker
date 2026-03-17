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
			const response = await fetchAndWait(
				'https://rownative.icu/oauth/callback?code=test-code&state=test-state',
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state');
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
});
