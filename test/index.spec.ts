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
});
