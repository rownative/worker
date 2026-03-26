import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	displayNameFromAthletePayload,
	fetchIntervalsActivities,
	fetchIntervalsStreams,
	fetchIntervalsAthleteProfile,
	isOtwRowing,
	parseStreamsResponse,
} from '../src/intervals-api';

describe('intervals-api', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('fetchIntervalsActivities parses JSON array', async () => {
		const activities = [{ id: '1', type: 'Rowing' }];
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify(activities), { status: 200 }) as Response,
		);
		const out = await fetchIntervalsActivities('ath1', 'token', '2024-01-01', '2024-01-31');
		expect(out).toEqual(activities);
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			expect.stringContaining('/api/v1/athlete/ath1/activities'),
			expect.objectContaining({ headers: { Authorization: 'Bearer token' } }),
		);
	});

	it('fetchIntervalsActivities throws on non-OK response', async () => {
		vi.mocked(fetch).mockResolvedValue(new Response('err', { status: 500 }) as Response);
		await expect(
			fetchIntervalsActivities('a', 't', '2024-01-01', '2024-01-31'),
		).rejects.toThrow('intervals.icu activities');
	});

	it('fetchIntervalsStreams returns parsed latlng/time from object shape', async () => {
		const raw = {
			latlng: { data: [1, 2], data2: [10, 20] },
			time: { data: [0, 1] },
		};
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify(raw), { status: 200 }) as Response,
		);
		const out = await fetchIntervalsStreams('act1', 'tok');
		expect(out.latlng).toEqual([
			[1, 10],
			[2, 20],
		]);
		expect(out.time).toEqual([0, 1]);
	});

	it('parseStreamsResponse handles array of stream objects', () => {
		const raw = [
			{ type: 'latlng', data: [0.1, 0.2], data2: [4.0, 4.1] },
			{ type: 'time', data: [0, 5] },
		];
		const out = parseStreamsResponse(raw);
		expect(out.latlng).toEqual([
			[0.1, 4.0],
			[0.2, 4.1],
		]);
		expect(out.time).toEqual([0, 5]);
	});

	it('isOtwRowing is true only for type Rowing', () => {
		expect(isOtwRowing({ id: '1', type: 'Rowing' })).toBe(true);
		expect(isOtwRowing({ id: '1', type: 'RowingIndoor' })).toBe(false);
	});

	it('fetchIntervalsAthleteProfile returns profile on success', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ id: 'a1', name: 'Test Rower' }), { status: 200 }) as Response,
		);
		const p = await fetchIntervalsAthleteProfile('tok');
		expect(p).toEqual({ id: 'a1', name: 'Test Rower' });
	});

	it('fetchIntervalsAthleteProfile accepts numeric id', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ id: 9001, name: 'Num Id' }), { status: 200 }) as Response,
		);
		const p = await fetchIntervalsAthleteProfile('tok');
		expect(p?.id).toBe('9001');
		expect(p?.name).toBe('Num Id');
	});

	it('fetchIntervalsAthleteProfile flattens nested athlete object', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({ athlete: { id: 'n1', firstName: 'A', lastName: 'B' } }),
				{ status: 200 },
			) as Response,
		);
		const p = await fetchIntervalsAthleteProfile('tok');
		expect(p?.id).toBe('n1');
		expect(p?.name).toBe('A B');
	});

	it('fetchIntervalsAthleteProfile uses firstName/lastName when name empty', async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({ id: 'a2', name: '', firstName: 'Ada', lastName: 'Lovelace' }),
				{ status: 200 },
			) as Response,
		);
		const p = await fetchIntervalsAthleteProfile('tok');
		expect(p?.name).toBe('Ada Lovelace');
		expect(p?.first_name).toBe('Ada');
		expect(p?.last_name).toBe('Lovelace');
	});

	it('displayNameFromAthletePayload joins camelCase names', () => {
		expect(
			displayNameFromAthletePayload({
				id: 'x',
				firstName: 'Bo',
				lastName: 'Klop',
			}),
		).toBe('Bo Klop');
	});

	it('fetchIntervalsAthleteProfile returns null on failure', async () => {
		vi.mocked(fetch).mockResolvedValue(new Response('', { status: 401 }) as Response);
		await expect(fetchIntervalsAthleteProfile('bad')).resolves.toBeNull();
	});
});
