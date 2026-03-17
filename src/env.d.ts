/**
 * Extend Env with secrets used by import-zip.
 * GITHUB_TOKEN: set via `wrangler secret put GITHUB_TOKEN` (PAT or GitHub App token).
 * GITHUB_REPO: optional, default "rownative/courses".
 */
declare namespace Cloudflare {
  interface Env {
    GITHUB_TOKEN?: string;
    GITHUB_REPO?: string;
  }
}
