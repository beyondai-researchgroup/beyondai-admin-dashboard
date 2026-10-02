// Google-side helpers for the per-researcher "Connect Google Forms" flow (Part G of the platform
// re-architecture, 2026-09-07) — mirrors server/calendar/googleOAuth.mjs almost exactly. A
// SEPARATE OAuth client registration/env vars from Calendar's (a researcher might read a form
// owned under a different Google account than their calendar one), but the same "one shared
// client, per-researcher refresh token" shape.
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/forms.body.readonly', 'https://www.googleapis.com/auth/userinfo.email'];

function newClient() {
  const clientId = process.env.GOOGLE_FORMS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_FORMS_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_FORMS_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'GOOGLE_FORMS_CLIENT_ID / GOOGLE_FORMS_CLIENT_SECRET / GOOGLE_FORMS_REDIRECT_URI are not set.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function buildAuthUrl(state) {
  const client = newClient();
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token, not just a short-lived access token
    prompt: 'consent', // forces the consent screen every time, guaranteeing a fresh refresh_token even on a reconnect
    scope: SCOPES,
    state,
  });
}

/** Exchanges an authorization code for tokens and reads the connected account's own email. */
export async function exchangeCode(code) {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token returned — this Google account likely already has an active grant for this app; ' +
        'revoke access at https://myaccount.google.com/permissions and try connecting again.'
    );
  }
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  return { refreshToken: tokens.refresh_token, email: data.email ?? null };
}

/** Best-effort revoke — called from /disconnect before clearing the stored token. Never throws. */
export async function revokeRefreshToken(refreshToken) {
  try {
    const client = newClient();
    await client.revokeToken(refreshToken);
    return true;
  } catch (err) {
    console.error('[google-forms-oauth] revoke failed (continuing with local disconnect anyway):', err?.message ?? err);
    return false;
  }
}

/** Returns an OAuth2 client with credentials set for making authenticated Forms API calls. */
export function clientForRefreshToken(refreshToken) {
  const client = newClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
