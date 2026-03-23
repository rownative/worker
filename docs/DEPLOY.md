# Worker Deployment Guide

This document covers deploying the rownative.icu worker to production and the surrounding infrastructure.

---

## Prerequisites

- Cloudflare account
- intervals.icu OAuth app (client ID and secret)
- GitHub account with access to `rownative/courses` (for course data and organiser config)
- Wrangler CLI: `npm install -g wrangler` or use `npx wrangler`

---

## 1. Cloudflare Setup

### 1.1 Create resources

```bash
# KV namespace for sessions, liked courses, caches
npx wrangler kv namespace create ROWING_COURSES

# D1 database for course times and challenges
npx wrangler d1 create rowing-courses-db
```

Add the namespace ID and database ID to `wrangler.jsonc` (or `wrangler.toml`):

```jsonc
{
  "kv_namespaces": [{ "binding": "ROWING_COURSES", "id": "<namespace-id>" }],
  "d1_databases": [{ "binding": "DB", "database_name": "rowing-courses-db", "database_id": "<database-id>" }]
}
```

### 1.2 Run migrations

```bash
npx wrangler d1 migrations apply rowing-courses-db --remote
```

Migrations are in `migrations/` and create tables for `course_times`, `challenges`, `challenge_results`, `standard_collections`, and `course_standards`.

---

## 2. Secrets

Set production secrets with `wrangler secret put`:

| Secret | Description |
|--------|-------------|
| `INTERVALS_CLIENT_ID` | From intervals.icu Developer Settings |
| `INTERVALS_CLIENT_SECRET` | From intervals.icu Developer Settings |
| `TOKEN_ENCRYPTION_KEY` | Random 32+ byte key for session encryption (e.g. `openssl rand -base64 32`) |
| `GITHUB_TOKEN` | GitHub PAT or App token (for course submit/update/import, organisers fetch) |

Optional: `GITHUB_REPO` env var (default: `rownative/courses`).

---

## 3. intervals.icu OAuth

1. Go to [intervals.icu](https://intervals.icu) → Settings → Developer
2. Create OAuth application
3. **Redirect URI**: `https://rownative.icu/oauth/callback` (production) or `http://localhost:8787/oauth/callback` (local)
4. **Scopes**: `ACTIVITY:READ`
5. Copy Client ID and Secret into Wrangler secrets

---

## 4. Deploy the Worker

```bash
npm run deploy
# or
npx wrangler deploy
```

The worker deploys to your Cloudflare account. Note the worker URL (e.g. `https://<worker>.<subdomain>.workers.dev`).

---

## 5. DNS and Routing

For `rownative.icu`:

- **Static site** (HTML, JS, CSS): Served by Cloudflare Pages or another host
- **API routes** (`/api/*`, `/oauth/*`): Routed to this worker

Common setup:

1. Create a Cloudflare Page or static host for the courses site
2. Add a Worker route: `rownative.icu/api/*` and `rownative.icu/oauth/*` → this worker
3. Ensure cookies work: same domain for site and API, or correct CORS/origin handling

---

## 6. Config Files (courses repo)

| File | Purpose |
|------|---------|
| `courses/organisers.json` | Array of intervals.icu athlete IDs with organiser access |
| `courses/removed-challenges.json` | Array of challenge IDs to hide (admin removal) |

Both are fetched from GitHub; update via PR. Worker caches organisers for 5 minutes.

---

## 7. Post-Deploy Checklist

- [ ] OAuth login works (test with intervals.icu)
- [ ] Course index loads (`/api/courses`)
- [ ] Course times can be saved and listed
- [ ] Challenges list and detail load
- [ ] Challenge submission works (GPS validation, display name pre-fill)
- [ ] Organiser panel accessible for users in `organisers.json`

---

## 8. Local Development

```bash
npm run dev
```

Local server runs at `http://localhost:8787`. Use `?local=1` on OAuth URLs for local redirect. Set `ROWNATIVE_API` in the site for local dev (e.g. `http://localhost:8787/api`).
