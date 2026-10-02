// Shared email-sending helper, sending from the shared beyondai.researchgroup@gmail.com account.
//
// Two transports, picked at runtime by which env vars are set:
//   1. Gmail API over HTTPS (production) — when GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET /
//      GMAIL_OAUTH_REFRESH_TOKEN are all set. Needed because Render's free tier blocks outbound
//      SMTP ports (25/465/587); the Gmail REST API goes over 443. The refresh token is obtained
//      once via admin-dashboard-andrejkatin/scripts/gmail-oauth-setup.mjs.
//   2. Gmail SMTP with an App Password (local dev) — GMAIL_USER / GMAIL_APP_PASSWORD, unchanged
//      from before. Used whenever the OAuth vars aren't set.
// GMAIL_USER is required either way (it's the From address). Never hardcode credentials — they
// come from .env/.env.local locally and from Render environment variables in production.
//
// This module is intentionally duplicated verbatim (not shared as a package) into every app that
// sends email — admin-dashboard, consent, rei40, bigfive — matching this codebase's convention of
// copy-pasting small cross-app utilities rather than maintaining a shared package across
// independent repos. Keep all four copies identical.
import nodemailer from 'nodemailer';

const DEFAULT_FROM_NAME = 'BeyondAI Research Group';

function useGmailApi() {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET &&
      process.env.GMAIL_OAUTH_REFRESH_TOKEN
  );
}

// ── Gmail API (HTTPS) ───────────────────────────────────────────────────────

let cachedAccessToken = null; // { value, expiresAt }

async function getGmailAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.value;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail OAuth token refresh failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  cachedAccessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedAccessToken.value;
}

// Builds the raw RFC 822 message with nodemailer's public stream transport (no network) — works
// identically across nodemailer v9 and v10, unlike importing its internal MailComposer.
const rawMessageBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true });

async function sendViaGmailApi(message) {
  const { message: raw } = await rawMessageBuilder.sendMail(message);
  const accessToken = await getGmailAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
  });
  if (!res.ok) {
    throw new Error(`Gmail API send failed (${res.status}): ${await res.text()}`);
  }
}

// ── Gmail SMTP (local dev) ──────────────────────────────────────────────────

let cachedSmtpTransporter = null;

function getSmtpTransporter() {
  if (cachedSmtpTransporter) return cachedSmtpTransporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'Email is not configured — set GMAIL_OAUTH_CLIENT_ID/_SECRET/_REFRESH_TOKEN (Gmail API) or GMAIL_USER/GMAIL_APP_PASSWORD (SMTP).'
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
  const fromAddress = process.env.GMAIL_USER;
  if (!fromAddress) {
    throw new Error('GMAIL_USER is not set — email sending is unavailable.');
  }
  // Strip quotes/CR/LF before interpolating into the quoted from-header — fromName can come from
  // researcher-supplied free text (Research.EmailSenderName), so this is header-injection/format
  // defense, not just cosmetic.
  const cleaned = fromName?.replace(/["\r\n]/g, '').trim();
  const displayName = cleaned || DEFAULT_FROM_NAME;
  const message = { from: `"${displayName}" <${fromAddress}>`, to, subject, html };

  if (useGmailApi()) {
    await sendViaGmailApi(message);
  } else {
    await getSmtpTransporter().sendMail(message);
  }
}
