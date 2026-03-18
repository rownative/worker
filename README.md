# worker

Cloudflare Worker backend for the [rownative.icu](https://rownative.icu) rowing app. It serves the course API, handles OAuth with [intervals.icu](https://intervals.icu), and powers features like liking courses, submitting new courses, and importing from Rowsandall.

## Architecture

The worker runs on Cloudflare and handles all `/api/*` and `/oauth/*` routes for rownative.icu. The static site is served separately (e.g. Cloudflare Pages). DNS routes `rownative.icu` so that API paths hit this worker.

## API Reference

### Course data (public)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/courses` | GET | — | Course index JSON. Optional geo filter: `?lat=&lon=&radius=` (all in meters; filters by haversine distance from center) |
| `/api/courses/kml` | GET | — | KML bundle for course IDs. Query: `?ids=1,2,3` (required) |
| `/api/courses/{id}` | GET | — | Single course KML. Optional: `?cn=true` for Chinese KML variant |
| `/api/me` | GET | — | Current user: `{ athleteId, liked }` or `{ athleteId: null, liked: [] }` |

### Authenticated endpoints (cookie or API key)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/courses/kml/liked` | GET | Cookie | KML bundle of the user's liked courses |
| `/api/rowers/courses/{id}/follow` | POST | Cookie | Like a course |
| `/api/rowers/courses/{id}/unfollow` | POST | Cookie | Unlike a course |
| `/api/courses/import-zip` | POST | Cookie | Import Rowsandall ZIP (multipart, `file` field) |
| `/api/courses/submit` | POST | Cookie | Submit new course (multipart, `file`, optional `name`) |
| `/api/courses/update` | POST | Cookie | Update provisional course (multipart, `id`, `file`, optional `name`) |
| `/api/auth/crewnerd` | POST | Bearer | Exchange intervals.icu bearer token for API key. Header: `Authorization: Bearer <token>`. Returns `{ api_key }` |
| `/api/me/activities` | GET | Cookie | OTW rowing activities from last month (for course time calculation) |
| `/api/courses/{id}/calculate-time` | POST | Cookie | Calculate time on course from activity. Body: `{ activityId }`. Returns `{ valid, timeS, distanceM, validationNote }` |
| `/api/courses/{id}/course-times` | POST | Cookie | Save course time. Body: `{ activityId, timeS, distanceM, validationNote }` |
| `/api/me/course-times` | GET | Cookie | List saved course times |

### Authentication methods

1. **Cookie (browser)** — After OAuth, the `rn_session` cookie authenticates requests. Used by the rownative.icu web app.
2. **API key (CrewNerd)** — Use `Authorization: ApiKey <athleteId>.<mac>` (obtained from `/api/auth/crewnerd`).

## OAuth Flow

Authentication with intervals.icu uses the standard OAuth 2.0 Authorization Code flow.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /oauth/authorize` | Begins the OAuth flow — redirects the user to intervals.icu |
| `GET /oauth/callback` | Handles the redirect back from intervals.icu, exchanges the code for a session |
| `GET /oauth/logout` | Clears the session cookie and redirects to `/` |

### State Parameter (CSRF Protection)

A random UUID is generated on each `/oauth/authorize` request and stored in two places: (1) a short-lived, `HttpOnly` cookie (`rn_oauth_state`, 10-minute `Max-Age`), and (2) KV with a 10-minute TTL. The same value is forwarded to intervals.icu as the `state` query parameter. On callback, the worker verifies state from the cookie (primary) or, if the cookie is absent (e.g. iOS ephemeral ASWebAuthenticationSession), from KV. A mismatch returns `400 Invalid state`.

### iOS / Native App Pitfalls

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `400 Invalid state` on callback | The OAuth state cookie is absent and state was not found in KV | State is stored in KV on authorize — if still failing, ensure the authorize and callback requests hit the same worker (same zone/deployment) |
| Decryption failure after login | Session cookie was URL-decoded before reaching the worker | Session cookies are now stored as URL-safe base64 (no `+`, `/`, or `=`) so they survive URL-decoding intact |

### Session Cookie

After a successful token exchange the worker stores an AES-256-GCM encrypted session in the `rn_session` cookie (URL-safe base64, `HttpOnly`, `Secure`, `SameSite=Lax`, 90-day `Max-Age`).

## Setup

### 1. intervals.icu OAuth app

Create an OAuth application at [intervals.icu](https://intervals.icu) and configure:

- **Redirect URI**: `https://rownative.icu/oauth/callback`
- **Scopes**: `ACTIVITY:READ` (or as needed)

### 2. KV namespace

Create a KV namespace and add it to `wrangler.jsonc`:

```json
"kv_namespaces": [
  { "binding": "ROWING_COURSES", "id": "<your-namespace-id>" }
]
```

The worker uses KV for: liked courses per athlete, OAuth state (fallback when cookies don't persist), and session-related data.

### 3. D1 database (Phase 2a — course times)

For production, create a D1 database and update `database_id` in `wrangler.jsonc`:

```bash
npx wrangler d1 create rowing-courses-db
npx wrangler d1 migrations apply rowing-courses-db --remote
```

Local development uses an ephemeral D1 instance; migrations run automatically.

### 4. Secrets

Set these via `wrangler secret put <NAME>`:

| Secret | Description |
|--------|-------------|
| `INTERVALS_CLIENT_ID` | OAuth client ID from intervals.icu |
| `INTERVALS_CLIENT_SECRET` | OAuth client secret from intervals.icu |
| `TOKEN_ENCRYPTION_KEY` | Secret used for AES-256-GCM session encryption (≥ 32 bytes) |
| `GITHUB_TOKEN` | GitHub PAT or App token for course import (submit, update, import-zip) |

`GITHUB_REPO` is an optional environment variable (default: `rownative/courses`).

## Development

```bash
npm install
npm test        # run unit tests with vitest
npm run dev     # start local dev server with wrangler
npm run deploy  # deploy to Cloudflare Workers
```

Local dev uses Miniflare with the same wrangler config. Ensure `wrangler.jsonc` includes a KV namespace binding for tests (or use a separate dev namespace).

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes, run tests, and open pull requests.
