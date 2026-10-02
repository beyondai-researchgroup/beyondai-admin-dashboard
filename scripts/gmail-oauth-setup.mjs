#!/usr/bin/env node
// One-time setup: obtains a Gmail API refresh token for the shared sending account
// (beyondai.researchgroup@gmail.com), used by every app's server/email/mailer.mjs in production
// (Render's free tier blocks outbound SMTP, so production sends through the Gmail REST API).
//
// Prerequisites (Google Cloud Console, same project as the Calendar/Forms OAuth clients):
//   1. APIs & Services → Library → "Gmail API" → Enable
//   2. Google Auth Platform → Data access → add scope https://www.googleapis.com/auth/gmail.send
//   3. Google Auth Platform → Clients → Create client → type "Desktop app"
//   4. Google Auth Platform → Audience → Publish app ("In production") — in "Testing" status
//      Google expires refresh tokens after 7 days, which would silently break email.
//
// Usage (PowerShell or bash; client id/secret come from step 3, never hardcode them here):
//   GMAIL_OAUTH_CLIENT_ID=... GMAIL_OAUTH_CLIENT_SECRET=... node scripts/gmail-oauth-setup.mjs
//
// Opens a Google sign-in page; sign in as beyondai.researchgroup@gmail.com and approve. The
// refresh token is printed once — store it as GMAIL_OAUTH_REFRESH_TOKEN (Render env var), next to
// GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_USER.
import http from 'node:http';
import { exec } from 'node:child_process';

const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET first (Desktop app OAuth client).');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh token even if this account already granted access before
    login_hint: 'beyondai.researchgroup@gmail.com',
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) {
    res.writeHead(404).end();
    return;
  }
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const body = await tokenRes.json();
    if (!tokenRes.ok || !body.refresh_token) {
      throw new Error(`Token exchange failed (${tokenRes.status}): ${JSON.stringify(body)}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Done — you can close this tab and return to the terminal.');
    console.log('\nGMAIL_OAUTH_REFRESH_TOKEN=' + body.refresh_token + '\n');
    console.log('Granted scope:', body.scope);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Token exchange failed — see terminal.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL and sign in as beyondai.researchgroup@gmail.com:\n');
  console.log(authUrl + '\n');
  const opener = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(opener, () => {});
});
