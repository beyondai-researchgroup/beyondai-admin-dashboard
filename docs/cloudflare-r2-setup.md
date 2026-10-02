# Cloudflare R2 setup — cloud storage for logs & uploads

Introduced 2026-10-01 so every file this platform accepts or generates (the Activity Log — a
real research instrument — plus Task Files, EEG recordings, Generic Task submissions, R-analysis
plots, and researcher avatars) keeps working once an app is hosted, not just in local dev. A
hosted container's local disk is ephemeral and not shared across instances, so anything that used
to rely on it needed a real, durable, off-box home.

**Design**: every upload/download route in `admin-dashboard-andrejkatin` and the Activity Log
piece of `code-review-ai`'s backend already works today by storing bytes directly in Postgres
(BYTEA/TEXT columns). That still works — R2 is **additive**: when the credentials below are set,
new uploads go to R2 instead (the DB row keeps only a `StorageKey` pointing at the R2 object);
when they're absent, everything behaves exactly as before this feature existed. A developer
machine with no R2 credentials needs **zero** setup — this whole guide is optional for local dev,
and only becomes necessary once you actually want the hosted (Render/Vercel) deployment to use
real cloud storage.

## 1. Create a Cloudflare account and an R2 bucket

1. Sign up (or log in) at [dash.cloudflare.com](https://dash.cloudflare.com) — free, no credit
   card required for R2's free tier (10GB storage, no egress fees).
2. In the left sidebar, open **R2 Object Storage**. If this is the account's first R2 bucket,
   Cloudflare will prompt you to enable R2 (still free tier, just a one-time opt-in).
3. Click **Create bucket**. Name it something like `beyondai-research-storage`. Leave location
   as "Automatic". Standard storage class.
4. Note your **Account ID** — shown in the R2 overview page's right sidebar, or under
   **Account Home → Account ID** (a 32-character hex string).

## 2. Create an API token (R2 credentials)

1. Still in **R2 Object Storage**, click **Manage R2 API Tokens** (or **{} API** in the bucket's
   own page).
2. **Create API token**. Give it a name (`beyondai-platform`), permission **Object Read & Write**,
   and scope it to the one bucket you just created (not "all buckets", for safety).
3. Cloudflare shows the credentials **exactly once** — copy them immediately:
   - **Access Key ID**
   - **Secret Access Key**
4. Combined with the bucket name and Account ID from step 1, you now have all 4 values every app
   below needs:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`

## 3. Wire the credentials into each app

Every app uses the **same bucket** — each one writes under its own key prefix
(`activity-logs/`, `task-files/`, `eeg/`, `generic-task-submissions/`, `analysis-plots/`,
`avatars/`), so nothing collides.

### admin-dashboard-andrejkatin (Node/Express)

Add to `.env.local` (local dev against the local Postgres) and/or `.env` (against Neon):

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=beyondai-research-storage
```

For the hosted deployment (wherever this app's API ends up running), set the same 4 as real
environment variables on that host.

### code-review-ai backend (ASP.NET Core — Activity Log)

Local dev, via user-secrets (never commit these):

```
dotnet user-secrets set "CloudStorage:R2:AccountId" "..." --project backend/CodeReviewAI.Api
dotnet user-secrets set "CloudStorage:R2:AccessKeyId" "..." --project backend/CodeReviewAI.Api
dotnet user-secrets set "CloudStorage:R2:SecretAccessKey" "..." --project backend/CodeReviewAI.Api
dotnet user-secrets set "CloudStorage:R2:Bucket" "beyondai-research-storage" --project backend/CodeReviewAI.Api
```

On Render, set as environment variables (same `__` double-underscore convention already used for
every other nested config key there):

```
CloudStorage__R2__AccountId=...
CloudStorage__R2__AccessKeyId=...
CloudStorage__R2__SecretAccessKey=...
CloudStorage__R2__Bucket=beyondai-research-storage
```

**Note**: unlike the other optional integrations in this codebase (Google Calendar, Google
Forms), R2 for the Activity Log is a "nice extra copy" — Postgres already durably stores the
finished CSV in production regardless of whether R2 is configured (the Activity Log accumulates
in memory now, not on local disk, so it no longer depends on the container's ephemeral
filesystem at all). Setting R2 here additionally uploads the full CSV as a real downloadable
object and keeps the Postgres row's `RawCsv` column empty for that session instead.

## 4. Verify it's working

Once credentials are set and the relevant server is restarted:

- **admin-dashboard**: upload a Task File, EEG recording, or researcher avatar. Check the R2
  bucket in the Cloudflare dashboard — a new object should appear under the matching prefix within
  a few seconds. Downloading it through the app should still work exactly as before.
- **code-review-ai (Activity Log)**: run a review session to completion (submit a decision).
  Check the Admin Dashboard's Participant Detail → Activity Log — it should still render
  correctly. Check the R2 bucket for a new object under `activity-logs/<participantId>/...`.

## 5. What's NOT covered by this round

- `task-app-andrejkatin`'s own Generic Task submission **upload** path (the write side — admin-
  dashboard's read/download/zip-export side already supports R2 via the shared `StorageKey`
  column, it just won't have anything to read from R2 until that app's own `server.mjs` is
  updated the same way). Flagged as a fast-follow, not done in this round.
- No backfill of **existing** rows already stored as BYTEA/TEXT in Neon — those keep working
  exactly as before (read routes fall back to the DB column when `StorageKey` is `NULL`); only
  new uploads made after R2 is configured go to R2. A one-time backfill script can be written
  later if moving everything off Postgres entirely ever becomes a real need.
