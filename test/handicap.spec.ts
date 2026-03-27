import { describe, it, expect } from 'vitest';
import { computeHandicap, type D1Database } from '../src/handicap';

function mockDb(firstImpl: (query: string, bindArgs: unknown[]) => Promise<unknown>): D1Database {
	return {
		prepare(query: string) {
			return {
				bind(...bindArgs: unknown[]) {
					return {
						first: () => firstImpl(query, bindArgs),
						all: async () => ({ results: [] }),
					};
				},
			};
		},
	};
}

describe('handicap', () => {
	it('computeHandicap returns null when collectionId is missing', async () => {
		const r = await computeHandicap(null, { rawTimeS: 100, boatType: '1x', sex: 'M' }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when boatType is empty', async () => {
		const r = await computeHandicap('hocr', { rawTimeS: 100, boatType: '', sex: 'M' }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when sex is empty', async () => {
		const r = await computeHandicap('hocr', { rawTimeS: 100, boatType: '1x', sex: '' }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when raw time is not positive', async () => {
		const r = await computeHandicap('hocr', { rawTimeS: 0, boatType: '1x', sex: 'M', courseDistanceM: 2000 }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when raw time is negative', async () => {
		const r = await computeHandicap('hocr', { rawTimeS: -1, boatType: '1x', sex: 'M', courseDistanceM: 2000 }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null for unknown collection without DB', async () => {
		const r = await computeHandicap('unknown-coll', { rawTimeS: 400, boatType: '1x', sex: 'M' }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when D1 has no matching standard', async () => {
		const db = mockDb(async () => null);
		const r = await computeHandicap(
			'custom-coll',
			{ rawTimeS: 400, boatType: '1x', sex: 'M', weightClass: 'HWT', courseDistanceM: 2000 },
			db,
		);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when standard_time_s is zero', async () => {
		const db = mockDb(async () => ({ standard_time_s: 0, course_distance_m: 500 }));
		const r = await computeHandicap(
			'custom-coll',
			{ rawTimeS: 400, boatType: '1x', sex: 'M', weightClass: 'HWT', courseDistanceM: 2000 },
			db,
		);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when standard_time_s is negative', async () => {
		const db = mockDb(async () => ({ standard_time_s: -10, course_distance_m: 500 }));
		const r = await computeHandicap(
			'custom-coll',
			{ rawTimeS: 400, boatType: '1x', sex: 'M', weightClass: 'HWT', courseDistanceM: 2000 },
			db,
		);
		expect(r).toBeNull();
	});

	it('computeHandicap uses builtin HOCR standards without DB', async () => {
		const r = await computeHandicap('hocr', {
			rawTimeS: 420,
			boatType: '1x',
			sex: 'M',
			weightClass: 'HWT',
			courseDistanceM: 2000,
		}, null);
		expect(r).not.toBeNull();
		expect(r!.correctedTimeS).toBeCloseTo(420, 5);
		expect(r!.points).toBeGreaterThan(0);
	});

	it('computeHandicap falls back to builtin 1x-M-HWT for unknown boat category on HOCR', async () => {
		const r = await computeHandicap(
			'hocr',
			{
				rawTimeS: 420,
				boatType: 'unknown-boat',
				sex: 'M',
				weightClass: 'HWT',
				courseDistanceM: 2000,
			},
			null,
		);
		expect(r).not.toBeNull();
		expect(r!.correctedTimeS).toBeCloseTo(420, 5);
	});

	it('computeHandicap resolves category fallback to HWT when LWT missing in builtin', async () => {
		const r = await computeHandicap('charles', {
			rawTimeS: 400,
			boatType: '1x',
			sex: 'M',
			weightClass: 'LWT',
			courseDistanceM: 2000,
		}, null);
		expect(r).not.toBeNull();
	});

	it('computeHandicap reads custom collection from D1 when not builtin', async () => {
		const db: D1Database = {
			prepare() {
				return {
					bind() {
						return {
							first: async () => ({
								standard_time_s: 400,
								course_distance_m: 500,
							}),
							all: async () => ({ results: [] }),
						};
					},
				};
			},
		};
		const r = await computeHandicap(
			'custom-coll',
			{
				rawTimeS: 400,
				boatType: '1x',
				sex: 'M',
				weightClass: 'HWT',
				courseDistanceM: 2000,
			},
			db,
		);
		expect(r).not.toBeNull();
		expect(r!.correctedTimeS).toBeGreaterThan(0);
	});

	it('computeHandicap uses age-band row from D1 and sets ageBand', async () => {
		const db = mockDb(async (query, bindArgs) => {
			if (query.includes('ORDER BY (age_max - age_min)')) {
				expect(bindArgs[4]).toBe(40);
				expect(bindArgs[5]).toBe(40);
				return {
					standard_time_s: 410,
					course_distance_m: 500,
					age_min: 27,
					age_max: 120,
				};
			}
			return null;
		});
		const r = await computeHandicap(
			'custom-coll',
			{
				rawTimeS: 400,
				boatType: '1x',
				sex: 'M',
				weightClass: 'HWT',
				courseDistanceM: 2000,
				crewAvgAge: 40,
			},
			db,
		);
		expect(r).not.toBeNull();
		expect(r!.ageBand).toBe('27-120');
		expect(r!.correctedTimeS).toBeGreaterThan(0);
	});

	it('computeHandicap falls back from LWT to HWT in D1 when open-age LWT row missing', async () => {
		const db = mockDb(async (_query, bindArgs) => {
			const wc = bindArgs[3];
			if (wc === 'LWT') return null;
			if (wc === 'HWT') {
				return { standard_time_s: 400, course_distance_m: 500 };
			}
			return null;
		});
		const r = await computeHandicap(
			'custom-coll',
			{
				rawTimeS: 400,
				boatType: '1x',
				sex: 'M',
				weightClass: 'LWT',
				courseDistanceM: 2000,
			},
			db,
		);
		expect(r).not.toBeNull();
		expect(r!.correctedTimeS).toBeGreaterThan(0);
	});
});
