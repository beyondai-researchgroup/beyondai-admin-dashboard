# Local dev database ("developer mode")

Lets `admin-dashboard-andrejkatin` and `consent-andrejkatin` run against a local Postgres copy
of the shared Neon database instead of Neon itself - useful when Neon is unavailable/rate-limited
(hit live 2026-09-08: a `402 "data transfer quota exceeded"` blocked every query, reads
included) or when you just don't want local testing to touch real data or spend Neon's quota.

**Production is completely untouched by any of this.** `npm run serve:api` (`.env`,
`DATABASE_URL`, no `DB_MODE`) always talks to Neon exactly as before - nothing here changes that
path. This is purely an *additional* opt-in mode.

## One-time setup

1. Docker Desktop must be running.
2. Start the local Postgres container (from `admin-dashboard-andrejkatin`):
   ```
   docker compose -f docker-compose.local-db.yml up -d
   ```
   This creates a `postgres:18` container on `localhost:5433` (not 5432, to avoid colliding with
   any other local Postgres), database `beyondai_dev`, user/password `postgres`/`postgres`, with
   a named volume so data survives a container restart.
3. Copy the current Neon schema + data into it (works even without `pg_dump`/`psql` installed on
   the host - both run inside throwaway containers):
   ```bash
   # from admin-dashboard-andrejkatin, with .env's DATABASE_URL available
   DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
   docker run --rm postgres:18 pg_dump "$DB_URL" --no-owner --no-privileges > neon_dump.sql
   docker exec -i admin-dashboard-andrejkatin-db-1 psql -U postgres -d beyondai_dev < neon_dump.sql
   rm neon_dump.sql   # contains real participant data - don't leave it lying around
   ```
   **Must be `postgres:18`, not `postgres:16`** - `pg_dump` refuses to dump from a server whose
   major version is newer than its own (confirmed live: Neon runs Postgres 18).
4. Each repo needs its own `.env.local` (git-ignored, same as `.env`) - copy `.env`, remove
   `DATABASE_URL`, add:
   ```
   DB_MODE=local
   LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/beyondai_dev
   ```

## Day to day

```
npm run serve:api:local     # instead of npm run serve:api - same app, local Postgres instead of Neon
```
Both repos' `server/local-db.mjs` (identical, duplicated on purpose - see its header comment) is
a small tagged-template wrapper around `pg.Pool` that mimics `@neondatabase/serverless`'s calling
convention closely enough that no route file needs to know or care which mode is active.

**Refreshing the local copy** from real data later: re-run step 3 above (the `pg_dump`/`psql`
pair) - safe to re-run any time, `--no-owner --no-privileges` plus `psql` replaying the same
`CREATE TABLE`/`COPY` statements just re-populates from scratch each time (drop/recreate the
container with `docker compose -f docker-compose.local-db.yml down -v` first if a from-scratch
restore is wanted instead of layering on top of existing local rows).

**Caveat**: the local copy is a full snapshot of real data (participant names/emails included) -
it sits in an unencrypted local Postgres container. Fine for solo local dev on your own machine;
don't share the container/volume or a `neon_dump.sql` file with anyone.
