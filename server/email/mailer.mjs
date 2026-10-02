// Shared email-sending helper, sending from the shared beyondai.researchgroup@gmail.com account.
//
// Two transports, picked at runtime by which env vars are set:
//   1. Google Apps Script relay over HTTPS (production) — when MAIL_RELAY_URL / MAIL_RELAY_SECRET
//      are set. Render's free tier blocks outbound SMTP (25/465/587), so production POSTs the
//      message to a small Apps Script web app owned by beyondai.researchgroup@gmail.com, which
//      sends it with MailApp (quota: 100 recipients/day on a consumer Gmail account). The script
//      source and setup steps live in admin-dashboard-andrejkatin/docs/email-relay-setup.md.
//   2. Gmail SMTP with an App Password (local dev) — GMAIL_USER / GMAIL_APP_PASSWORD, unchanged
//      from before. Used whenever the relay vars aren't set.
// Never hardcode credentials — they come from .env/.env.local locally and from Render
// environment variables in production.
//
// This module is intentionally duplicated verbatim (not shared as a package) into every app that
// sends email — admin-dashboard, consent, rei40, bigfive — matching this codebase's convention of
// copy-pasting small cross-app utilities rather than maintaining a shared package across
// independent repos. Keep all four copies identical.
import nodemailer from 'nodemailer';

const DEFAULT_FROM_NAME = 'BeyondAI Research Group';
const RELAY_TIMEOUT_MS = 30_000;
const RELAY_ATTEMPTS = 3;
const RELAY_RETRY_DELAY_MS = 1500;

// ── Apps Script relay (HTTPS) ───────────────────────────────────────────────

async function sendViaRelay({ to, subject, html, fromName }) {
  const body = JSON.stringify({ secret: process.env.MAIL_RELAY_SECRET, to, subject, html, fromName });
  let lastError;
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt++) {
    // Apps Script answers a POST with a 302 to script.googleusercontent.com carrying the result;
    // fetch follows it (as a GET) by default, which is exactly how Apps Script web apps expect to
    // be called. The script always answers 200, so success is read from the JSON body.
    const res = await fetch(process.env.MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      // Apps Script intermittently answers with a transient HTML error page (observed live,
      // typically on the first call after the script has been idle) before doPost ever runs —
      // retry those. A JSON answer, including {ok:false}, is final and never retried.
      lastError = new Error(`Mail relay returned a non-JSON response (${res.status}): ${text.slice(0, 200)}`);
      if (attempt < RELAY_ATTEMPTS) await new Promise((r) => setTimeout(r, RELAY_RETRY_DELAY_MS));
      continue;
    }
    if (!result.ok) {
      throw new Error(`Mail relay refused the message: ${result.error ?? 'unknown error'}`);
    }
    return;
  }
  throw lastError;
}

// ── Gmail SMTP (local dev) ──────────────────────────────────────────────────

let cachedSmtpTransporter = null;

function getSmtpTransporter() {
  if (cachedSmtpTransporter) return cachedSmtpTransporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'Email is not configured — set MAIL_RELAY_URL/MAIL_RELAY_SECRET (production) or GMAIL_USER/GMAIL_APP_PASSWORD (local SMTP).'
    );
  }
  cachedSmtpTransporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return cachedSmtpTransporter;
}

/**
 * Sends a single HTML email from the shared beyondai.researchgroup@gmail.com account.
 * @param {{ to: string, subject: string, html: string, fromName?: string }} params
 *
 * fromName: optional display-name override (e.g. a research's own EmailSenderName) — only the
 * display-name portion of `from` can change, never the actual address. Defaults to "BeyondAI
 * Research Group", so every pre-existing caller is unaffected.
 */
export async function sendMail({ to, subject, html, fromName }) {
  // Strip quotes/CR/LF — fromName can come from researcher-supplied free text
  // (Research.EmailSenderName), so this is header-injection/format defense, not just cosmetic.
  const cleaned = fromName?.replace(/["\r\n]/g, '').trim();
  const displayName = cleaned || DEFAULT_FROM_NAME;

  if (process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET) {
    await sendViaRelay({ to, subject, html, fromName: displayName });
    return;
  }

  const fromAddress = process.env.GMAIL_USER;
  await getSmtpTransporter().sendMail({ from: `"${displayName}" <${fromAddress}>`, to, subject, html });
}
