# worker

Cloudflare Worker backend for the [rownative.icu](https://rownative.icu) rowing app.

## Authentication Flow

Authentication with [intervals.icu](https://intervals.icu) uses the standard OAuth 2.0 Authorization Code flow.

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /oauth/authorize` | Begins the OAuth flow — redirects the user to intervals.icu |
| `GET /oauth/callback` | Handles the redirect back from intervals.icu, exchanges the code for a session |
| `GET /oauth/logout` | Clears the session cookie and redirects to `/` |

### State Parameter (CSRF Protection)

A random UUID is generated on each `/oauth/authorize` request and stored in two places: (1) a short-lived, `HttpOnly` cookie (`rn_oauth_state`, 10-minute `Max-Age`), and (2) KV with a 10-minute TTL. The same value is forwarded to intervals.icu as the `state` query parameter. On callback, the worker verifies state from the cookie (primary) or, if the cookie is absent (e.g. iOS ephemeral ASWebAuthenticationSession), from KV. A mismatch returns `400 Invalid state`.

### iOS / Native App Pitfalls

| Symptom | Likely Cause | Fix |
|---|---|---|
| `400 Invalid state` on callback | The OAuth state cookie is absent and state was not found in KV | State is stored in KV on authorize — if still failing, ensure the authorize and callback requests hit the same worker (same zone/deployment) |
| Decryption failure after login | Session cookie was URL-decoded before reaching the worker | Session cookies are now stored as URL-safe base64 (no `+`, `/`, or `=`) so they survive URL-decoding intact |

### Session Cookie

After a successful token exchange the worker stores an AES-256-GCM encrypted session in the `rn_session` cookie (URL-safe base64, `HttpOnly`, `Secure`, `SameSite=Lax`, 90-day `Max-Age`).

## Required Secrets

Set these via `wrangler secret put <NAME>`:

| Secret | Description |
|---|---|
| `INTERVALS_CLIENT_ID` | OAuth client ID from intervals.icu |
| `INTERVALS_CLIENT_SECRET` | OAuth client secret from intervals.icu |
| `TOKEN_ENCRYPTION_KEY` | Secret used for AES-256-GCM session encryption (≥ 32 bytes) |
| `GITHUB_TOKEN` | GitHub PAT or App token for course import |

`GITHUB_REPO` is an optional environment variable (default: `rownative/courses`).

## Development

```bash
npm install
npm test        # run unit tests with vitest
npm run dev     # start local dev server with wrangler
npm run deploy  # deploy to Cloudflare Workers
```
