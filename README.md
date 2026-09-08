# worker

Cloudflare Worker backend for the [rownative.icu](https://rownative.icu) rowing app. It serves the course API, handles OAuth with [intervals.icu](https://intervals.icu), and powers features like liking courses, submitting new courses, and importing from Rowsandall.

## Architecture

The worker runs on Cloudflare and handles all `/api/*` and `/oauth/*` routes for rownative.icu. The static site is served separately (e.g. Cloudflare Pages). DNS routes `rownative.icu` so that API paths hit this worker.

## API Reference

### Course data (public)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/courses` | GET | — | Course index. Returns `{ courses }`. Optional geo filter: `?lat=&lon=&radius=` (all in meters; filters by haversine distance from center) |
| `/api/courses/kml` | GET | — | KML bundle for course IDs. Query: `?ids=1,2,3` (required) |
| `/api/courses/{id}` | GET | — | Single course KML. Optional: `?cn=true` for Chinese KML variant |
| `/api/me` | GET | — | Current user: `{ athleteId, liked, isOrganizer, athleteDisplayName? }` or `{ athleteId: null, liked: [], isOrganizer: false }`. `athleteDisplayName` from intervals.icu profile (for challenge submission pre-fill). |

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
| `/api/courses/{id}/course-times` | POST | Cookie | Save course time. Body: `{ activityId, timeS, distanceM, validationNote?, workoutDate? }` (workoutDate: YYYY-MM-DD of the workout) |
| `/api/me/course-times` | GET | Cookie | List saved course times (returns `{ courseTimes }` with `id`, `activity_id`, `course_id`, `time_s`, `distance_m`, `workout_date`, `created_at`, etc.) |
| `/api/me/course-times/{id}` | DELETE | Cookie | Remove a saved course time by id |

### Challenges (public)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/challenges` | GET | — | List challenges. Query: `?status=active\|upcoming\|past` (default: active). Returns `{ challenges }` |
| `/api/challenges/{id}` | GET | — | Challenge detail |
| `/api/challenges/{id}/results` | GET | — | Leaderboard results (valid/manual_ok only). Returns `{ results }` |
| `/api/challenges/{id}/submit` | POST | Cookie | Submit result. Body: `{ activityId, displayName?, boatType?, sex? }`. GPS validation via calculateCourseTime; workout date must be within row window |

### Organiser (auth + isOrganizer required)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/organiser/challenges` | GET | Cookie | My challenges. Returns `{ challenges }` |
| `/api/organiser/challenges` | POST | Cookie | Create challenge. Body: `{ name, courseId, rowStart, rowEnd, submitEnd, collectionId?, notes?, isPublic? }` |
| `/api/organiser/standard-collections` | GET | Cookie | List standard collections (built-in + custom). Returns `{ collections }` |
| `/api/organiser/standard-collections` | POST | Cookie | Create custom collection. Body: JSON `{ name }` or multipart `name` (+ optional `file`) |

### Authentication methods

1. **Cookie (browser)** — After OAuth, the `rn_session` cookie authenticates requests. Used by the rownative.icu web app.
2. **API key (CrewNerd)** — Use `Authorization: ApiKey <athleteId>.<mac>` (obtained from `/api/auth/crewnerd`). Recommended for best performance (local verification, no external API calls).
3. **Bearer token (CrewNerd)** — Use `Authorization: Bearer <intervals.icu_token>` directly on data endpoints. Backward compatible with the old RowsAndAll API. Validated against intervals.icu and cached for 1 hour.

#### CrewNerd Authentication Trade-offs

| Method | Flow | Performance | External API Dependency |
|--------|------|-------------|------------------------|
| **API key** (new) | 2-step: exchange token → use API key | Fast (local HMAC verification) | Only on initial exchange |
| **Bearer token** (legacy) | 1-step: use token directly | First request slower, cached 1h | intervals.icu on cache miss |

Both methods are supported permanently. The API key flow is recommended for production use due to its independence from external services once the key is obtained.

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

The worker uses KV for: liked courses per athlete, OAuth state (fallback when cookies don't persist), organisers list (cached from `courses/organisers.json` on GitHub), and session-related data.

### 3. D1 database (Phase 2a — course times)

For production, create a D1 database and update `database_id` in `wrangler.jsonc`:

```bash
npx wrangler d1 create rowing-courses-db
npx wrangler d1 migrations apply rowing-courses-db --remote
```

For local dev, run `npx wrangler d1 migrations apply rowing-courses-db --local` before `npm run dev` (or let `npm run dev` do it automatically).

### 4. Secrets

Set these via `wrangler secret put <NAME>`:

| Secret | Description |
|--------|-------------|
| `INTERVALS_CLIENT_ID` | OAuth client ID from intervals.icu |
| `INTERVALS_CLIENT_SECRET` | OAuth client secret from intervals.icu |
| `TOKEN_ENCRYPTION_KEY` | Secret used for AES-256-GCM session encryption (≥ 32 bytes) |
| `GITHUB_TOKEN` | GitHub PAT or App token for course import (submit, update, import-zip) |

`GITHUB_REPO` is an optional environment variable (default: `rownative/courses`).

See [docs/DEPLOY.md](docs/DEPLOY.md) for full deployment instructions.

## Development

```bash
npm install
npm test        # run unit tests with vitest
npm run dev     # start local dev server with wrangler
npm run deploy  # deploy to Cloudflare Workers
```

Local dev uses Miniflare with the same wrangler config. Ensure `wrangler.jsonc` includes a KV namespace binding for tests (or use a separate dev namespace).

### OAuth and secrets locally (`client_id=undefined`)

`wrangler secret put` applies to **deployed** Workers only. For **`npm run dev`**, Wrangler reads **[`.dev.vars`](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets)** (gitignored).

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Set `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` (same values you use in production secrets, or a dev OAuth app).
3. In your intervals.icu app settings, add redirect URI **`http://localhost:8787/oauth/callback`** (in addition to production if needed).
4. Restart `npm run dev`.

If `INTERVALS_CLIENT_ID` is missing, the authorize URL sent to intervals.icu will contain `client_id=undefined` and their server will error.

### Frontend against local Worker

From the **courses** repo, run `npm run dev` for the static site, then open the URL documented in [courses `CONTRIBUTING.md` — Local development with real Worker](https://github.com/rownative/courses/blob/main/CONTRIBUTING.md) (`?debug=1&api=http://localhost:8787/api`).

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes, run tests, and open pull requests.


Course calculation failures include `gateDiagnostics` with `reason` (`no_gates`,
`missed_gates`, or `gate_order`) and the course's `gates`, each containing its
polygon and a `passed` flag. Flags use the timing algorithm's crossing rules
(exit for start/intermediate gates, entry for finish). `gate_order` means every
gate was crossed individually but no complete ordered passage was found.
For `no_gates`, the client displays a plain message and no diagnostic map.
Other failures include the full original GPS coordinates in `latlng` so display
simplification does not obscure narrow gate crossings. Successful responses
retain the existing map downsampling. The map dialog requires the companion
`courses` frontend update; `validationNote` remains available for debugging.
