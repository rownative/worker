# Deployment — rownative Worker

## Routine deploy

```bash
npx wrangler deploy
```

## First-time setup (Phase 2a — course times)

### Check if D1 already exists

Requires Cloudflare auth (`npx wrangler login` or `CLOUDFLARE_API_TOKEN`):

```bash
npx wrangler d1 list
```

Look for `rowing-courses-db`. If it appears with a real UUID, the DB exists and you only need to ensure migrations are applied (see below).

### Migrations

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
