import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/env.d.ts', '**/index.ts'],
			thresholds: {
				lines: 40,
				'src/kml-to-course.ts': { lines: 75 },
				'src/course-time.ts': { lines: 75 },
				'src/content-filter.ts': { lines: 75 },
				'src/handicap.ts': { lines: 95 },
			},
		},
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					vars: {
						GITHUB_REPO: 'rownative/courses',
						INTERVALS_CLIENT_ID: 'test-client-id',
						INTERVALS_CLIENT_SECRET: 'test-client-secret',
						TOKEN_ENCRYPTION_KEY: 'test-encryption-key-32-chars!!xx',
					},
				},
			},
		},
	},
});
