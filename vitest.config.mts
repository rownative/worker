import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
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
