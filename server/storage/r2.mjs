// Cloudflare R2 cloud storage — a thin wrapper around the S3-compatible API (R2 speaks the real
// S3 protocol, so the standard @aws-sdk/client-s3 client works unmodified, just pointed at R2's
// own endpoint instead of AWS). Introduced 2026-10-01 so the Activity Log (a real research
// instrument) and every other upload this app accepts (Task Files, EEG recordings, Generic Task
// submissions, R-analysis plots, researcher avatars) keep working once the app is hosted — a
// Render/Vercel container's local disk is ephemeral and not shared across instances, so anything
// that used to rely on it (Activity Log's CSV file) or lived only as a Postgres BYTEA/TEXT column
// now has a real off-box home instead.
//
// Gated entirely on 5 env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
// optionally R2_PUBLIC_URL) — same "absent config disables the feature, falls back to the
// pre-existing behavior" discipline as every other optional integration in this codebase (Google
// Calendar, Google Forms, EEG device gating, per-app timers). A developer machine with no R2
// credentials set keeps working exactly as it did before this file existed: every call site below
// checks isConfigured() first and falls back to storing bytes directly in the DB column it always
// used. See docs/cloudflare-r2-setup.md for how to obtain the credentials.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

let client = null;
let bucket = null;

function init() {
  if (client !== null || bucket !== null) return; // already attempted (success or permanent no-op)
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  bucket = process.env.R2_BUCKET || null;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    bucket = null; // keep isConfigured() false even if only the bucket name was missing
    return;
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/** True once all 4 required R2 env vars are present — every call site branches on this before
 *  touching R2 at all, so an unconfigured environment never even attempts a network call. */
export function isConfigured() {
  init();
  return client !== null;
}

/**
 * Uploads a buffer to R2 under `key` and returns that same key (the caller stores it as the row's
 * StorageKey). `key` should already be namespaced (see buildKey()) — this function does no
 * sanitizing of its own.
 */
export async function putObject(key, buffer, contentType) {
  init();
  if (!client) throw new Error('R2 is not configured');
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

/** Downloads an object's full bytes as a Buffer. Throws if R2 is unconfigured or the key doesn't exist. */
export async function getObject(key) {
  init();
  if (!client) throw new Error('R2 is not configured');
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Downloads an object as a UTF-8 string (CSV/text content — Activity Log, EEG raw CSV). */
export async function getObjectText(key) {
  const buf = await getObject(key);
  return buf.toString('utf-8');
}

/** Deletes an object. Best-effort is the CALLER's responsibility (matches every other
 *  best-effort side-effect convention in this codebase) — this function itself still throws on
 *  a genuine failure so a caller that wants to know can catch it. */
export async function deleteObject(key) {
  init();
  if (!client) throw new Error('R2 is not configured');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Builds a namespaced object key: "<prefix>/<researchId or participant id>/<timestamp>-<safe filename>".
 *  Keeps every upload type's objects visually separated in the bucket (activity-logs/, task-files/,
 *  eeg/, generic-task-submissions/, analysis-plots/, avatars/) without needing separate buckets. */
export function buildKey(prefix, scopeId, originalFilename) {
  const safeName = String(originalFilename || 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-150); // keep the tail (extension, most-distinguishing part) if a filename is very long
  return `${prefix}/${scopeId}/${Date.now()}-${safeName}`;
}
