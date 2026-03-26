import { describe, it, expect } from 'vitest';
import { computeHandicap, type D1Database } from '../src/handicap';

describe('handicap', () => {
	it('computeHandicap returns null when collectionId is missing', async () => {
		const r = await computeHandicap(null, { rawTimeS: 100, boatType: '1x', sex: 'M' }, null);
		expect(r).toBeNull();
	});

	it('computeHandicap returns null when raw time is not positive', async () => {
		const r = await computeHandicap('hocr', { rawTimeS: 0, boatType: '1x', sex: 'M', courseDistanceM: 2000 }, null);
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
});
