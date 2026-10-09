// Google-side helpers for the per-researcher "Connect Google Calendar" flow (see
// server/calendar/routes.mjs for the actual /connect and /oauth2callback endpoints, and
// src/app/settings/ for the frontend that triggers it).
//
// One shared OAuth *client registration* (GOOGLE_CALENDAR_CLIENT_ID/SECRET, a "Web application"
// type client in Google Cloud Console) is used by every researcher — that's normal, it's the
// resulting refresh token per researcher that's the actually-personal part, stored encrypted on
// their own Researcher row (server/calendar/tokenCrypto.mjs).
import { oauth2 as googleOauth2 } from '@googleapis/oauth2';
import { OAuth2Client } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/userinfo.email'];

function newClient() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET / GOOGLE_CALENDAR_REDIRECT_URI are not set.'
    );
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
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

  const oauth2 = googleOauth2({ version: 'v2', auth: client });
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
    console.error('[google-oauth] revoke failed (continuing with local disconnect anyway):', err?.message ?? err);
    return false;
  }
}
