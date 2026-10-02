// Per-researcher "Connect Google Calendar" flow. Unlike every other router in this app, this one
// does NOT blanket-apply requireAuth via router.use — /connect is reached by a real full-page
// browser navigation (an <a href>, not an XHR), so it can't carry an Authorization header, and
// /oauth2callback is called by Google itself, unauthenticated by definition. Each route applies
// whatever check actually fits it.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { verifyToken } from '../auth/jwt.mjs';
import { buildAuthUrl, exchangeCode, revokeRefreshToken } from './googleOAuth.mjs';
import { encrypt, decrypt } from './tokenCrypto.mjs';

const router = Router();

const STATE_PURPOSE = 'calendar-connect';

// Bug fix (2026-09-07, found while building the identical Google Forms OAuth flow in Part G of
// the platform re-architecture): both redirects below used to target /settings, a route that no
// longer exists since Settings merged into /configuration — the connect confirmation banner never
// actually showed. Redirect target corrected to /configuration; ConfigurationComponent already
// reads the same calendarConnected/calendarError query params, unchanged.

router.get('/status', requireAuth, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "GoogleCalendarEmail" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const email = rows[0]?.GoogleCalendarEmail ?? null;
    res.json({ connected: !!email, email });
  } catch (err) {
    console.error('[calendar] status error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// A real browser navigation (window.location.href = ...), not an XHR — the JWT is passed as a
// query param since a top-level navigation can't set an Authorization header. Verified the same
// way requireAuth verifies a header-borne token, just read from a different place.
router.get('/connect', (req, res) => {
  const appUrl = process.env.ADMIN_DASHBOARD_APP_URL || '';
  const token = req.query.token;
  if (typeof token !== 'string' || !token) {
    res.status(401).send('Missing token');
    return;
  }
  let researcherId;
  try {
    researcherId = verifyToken(token).sub;
  } catch {
    res.status(401).send('Invalid or expired session — please log in again.');
    return;
  }

  const state = jwt.sign({ purpose: STATE_PURPOSE, researcherId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  try {
    res.redirect(buildAuthUrl(state));
  } catch (err) {
    // Same fix as google-forms/routes.mjs's identical /connect (2026-09-07) — a clean redirect
    // with a distinct error code instead of a bare plaintext page.
    console.error('[calendar] connect error:', err);
    res.redirect(`${appUrl}/configuration?calendarError=not_configured`);
  }
});

// Google redirects here after consent. Public — no requireAuth possible (Google, not our
// frontend, is the caller) — the signed, short-lived `state` value is what authenticates this.
router.get('/oauth2callback', async (req, res) => {
  const appUrl = process.env.ADMIN_DASHBOARD_APP_URL || '';
  const { code, state, error } = req.query;

  if (error) {
    console.error('[calendar] oauth2callback: Google returned an error:', error);
    res.redirect(`${appUrl}/configuration?calendarError=1`);
    return;
  }
  if (typeof state !== 'string' || typeof code !== 'string') {
    res.redirect(`${appUrl}/configuration?calendarError=1`);
    return;
  }

  let researcherId;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== STATE_PURPOSE) throw new Error('wrong state purpose');
    researcherId = payload.researcherId;
  } catch (err) {
    console.error('[calendar] oauth2callback: invalid/expired state:', err?.message ?? err);
    res.redirect(`${appUrl}/configuration?calendarError=1`);
    return;
  }

  try {
    const { refreshToken, email } = await exchangeCode(code);
    const sql = getDb();
    await sql`
      UPDATE "Researcher"
      SET "GoogleCalendarRefreshTokenEnc" = ${encrypt(refreshToken)},
          "GoogleCalendarEmail" = ${email},
          "GoogleCalendarConnectedAt" = NOW()
      WHERE "Id" = ${researcherId}
    `;
    res.redirect(`${appUrl}/configuration?calendarConnected=1`);
  } catch (err) {
    console.error('[calendar] oauth2callback: token exchange/store failed:', err?.message ?? err);
    res.redirect(`${appUrl}/configuration?calendarError=1`);
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "GoogleCalendarRefreshTokenEnc" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const encToken = rows[0]?.GoogleCalendarRefreshTokenEnc;
    if (encToken) {
      // Best-effort — a failed revoke must not block disconnecting in-app; the token is cleared
      // from our DB regardless.
      await revokeRefreshToken(decrypt(encToken));
    }

    await sql`
      UPDATE "Researcher"
      SET "GoogleCalendarRefreshTokenEnc" = NULL, "GoogleCalendarEmail" = NULL, "GoogleCalendarConnectedAt" = NULL
      WHERE "Id" = ${req.researcher.id}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[calendar] disconnect error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
