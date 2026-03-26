# Deployment — rownative Worker

## Routine deploy

```bash
npx wrangler deploy
```

### Deploying without losing secrets or dashboard variables

- **Secrets** (`INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GITHUB_TOKEN`, …) set in the Cloudflare dashboard or via `wrangler secret put` are **not deleted** when you deploy. A normal `wrangler deploy` updates **code and config** (routes, bindings); it does not wipe remote secrets.

- If Wrangler **prompts** about replacing or syncing values that conflict with what is in [`wrangler.jsonc`](wrangler.jsonc) `vars` (e.g. the placeholder `INTERVALS_*` strings), choose the option that **keeps** your existing Cloudflare secrets / production values, or cancel and fix the prompt cause (see below).

- **Plain Variables** (non-secret) you added only in the dashboard can be removed on deploy: Wrangler’s default is to align `vars` with the config file. If you rely on **dashboard-only** vars, deploy with:
  ```bash
  npx wrangler deploy --keep-vars
  ```
  so existing environment variables are not cleared before applying values from `wrangler.jsonc`. (Secrets are still never deleted by deployments.)

- **Avoid** passing sensitive values with `--var KEY=value` on the command line (shell history, CI logs).

- **Optional cleanup:** The repo uses placeholder `vars` for `INTERVALS_*` so local dev never sees `undefined`. If deploy keeps asking to reconcile those names with your **secrets**, you can remove those keys from `vars` in `wrangler.jsonc` and rely on `.dev.vars` locally + secrets remotely—then there is nothing to “overwrite” at deploy time.

## First-time setup (Phase 2a — course times)

### Check if D1 already exists

Requires Cloudflare auth (`npx wrangler login` or `CLOUDFLARE_API_TOKEN`):

```bash
npx wrangler d1 list
```

Look for `rowing-courses-db`. If it appears with a real UUID, the DB exists and you only need to ensure migrations are applied (see below).

### Migrations

Migrations live in `migrations/`:
- `0001_course_times.sql` — creates `course_times` table
- `0002_course_times_workout_date.sql` — adds `workout_date` column (workout date, not calculation date)
- `0003_course_times_workout_name.sql` — adds `workout_name` column
- `0004_standard_collections.sql` — creates `standard_collections` table
- `0005_challenges.sql` — creates `challenges` table
- `0006_challenge_results.sql` — creates `challenge_results` table

- **Local** (dev): `migrations apply` defaults to local. Migrations run automatically when using `npx wrangler dev`.
- **Remote** (production): Use `--remote`:

  ```bash
  npx wrangler d1 migrations apply rowing-courses-db --remote
  ```

Check pending migrations:

```bash
npx wrangler d1 migrations list rowing-courses-db --remote
```

### Create D1 (if missing)

1. Create the database:
   ```bash
   npx wrangler d1 create rowing-courses-db --binding DB --update-config
   ```
   `--update-config` adds the binding and `database_id` to `wrangler.jsonc`. If you already have a D1 block with placeholder ID, you may need to manually copy the new `database_id` from the command output into your config.

2. Apply migrations to the remote DB:
   ```bash
   npx wrangler d1 migrations apply rowing-courses-db --remote
   ```

3. Deploy:
   ```bash
   npx wrangler deploy
   ```

## Prerequisites (unchanged)

- **intervals.icu OAuth**: `ACTIVITY:READ` scope for `/api/me/activities` and streams.
- **Secrets**: `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`; `GITHUB_TOKEN` if using import/submit.

## Site (courses)

The static site (Cloudflare Pages) is deployed separately. Deploy it as usual for your Pages setup (e.g. `git push` or Pages build pipeline).

## Routes (Worker triggers)

The Worker handles `/api/*` and `/oauth/*`. Routes are defined in `wrangler.jsonc` and applied on `npx wrangler deploy`. If `/api/me/activities` (or other API paths) return 404, ensure:

1. The Worker is deployed: `npx wrangler deploy`
2. `rownative.icu` is added to your Cloudflare zone
3. Routes in wrangler.jsonc match your domain (pattern: `rownative.icu/api/*`, `rownative.icu/oauth/*`)

If routes were previously configured manually in the Cloudflare dashboard, redeploying with wrangler may update them.
