// Per-researcher "Connect Google Forms" flow (Part G of the platform re-architecture,
// 2026-09-07) — mirrors server/calendar/routes.mjs's shape exactly (same real-navigation
// /connect + unauthenticated /oauth2callback + requireAuth-gated /status and /disconnect
// pattern), talking to its own separate OAuth client/columns.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { verifyToken } from '../auth/jwt.mjs';
import { buildAuthUrl, exchangeCode, revokeRefreshToken } from './oauth.mjs';
import { encrypt, decrypt } from './tokenCrypto.mjs';

const router = Router();

const STATE_PURPOSE = 'google-forms-connect';

router.get('/status', requireAuth, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "GoogleFormsEmail" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const email = rows[0]?.GoogleFormsEmail ?? null;
    res.json({ connected: !!email, email });
  } catch (err) {
    console.error('[google-forms] status error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// A real browser navigation (window.location.href = ...), not an XHR — the JWT is passed as a
// query param since a top-level navigation can't set an Authorization header.
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
    // GOOGLE_FORMS_CLIENT_ID/SECRET/REDIRECT_URI not set yet (docs/google-forms-setup.md) — a
    // clean redirect back into the app with a distinct error code instead of a bare plaintext
    // page, so ConfigurationComponent can show "not configured yet" rather than a generic
    // "connection failed, try again" that implies the researcher did something wrong.
    console.error('[google-forms] connect error:', err);
    res.redirect(`${appUrl}/configuration?googleFormsError=not_configured`);
  }
});

// Google redirects here after consent. Public — no requireAuth possible (Google, not our
// frontend, is the caller) — the signed, short-lived `state` value is what authenticates this.
router.get('/oauth2callback', async (req, res) => {
  const appUrl = process.env.ADMIN_DASHBOARD_APP_URL || '';
  const { code, state, error } = req.query;

  if (error) {
    console.error('[google-forms] oauth2callback: Google returned an error:', error);
    res.redirect(`${appUrl}/configuration?googleFormsError=1`);
    return;
  }
  if (typeof state !== 'string' || typeof code !== 'string') {
    res.redirect(`${appUrl}/configuration?googleFormsError=1`);
    return;
  }

  let researcherId;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== STATE_PURPOSE) throw new Error('wrong state purpose');
    researcherId = payload.researcherId;
  } catch (err) {
    console.error('[google-forms] oauth2callback: invalid/expired state:', err?.message ?? err);
    res.redirect(`${appUrl}/configuration?googleFormsError=1`);
    return;
  }

  try {
    const { refreshToken, email } = await exchangeCode(code);
    const sql = getDb();
    await sql`
      UPDATE "Researcher"
      SET "GoogleFormsRefreshTokenEnc" = ${encrypt(refreshToken)},
          "GoogleFormsEmail" = ${email},
          "GoogleFormsConnectedAt" = NOW()
      WHERE "Id" = ${researcherId}
    `;
    res.redirect(`${appUrl}/configuration?googleFormsConnected=1`);
  } catch (err) {
    console.error('[google-forms] oauth2callback: token exchange/store failed:', err?.message ?? err);
    res.redirect(`${appUrl}/configuration?googleFormsError=1`);
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "GoogleFormsRefreshTokenEnc" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const encToken = rows[0]?.GoogleFormsRefreshTokenEnc;
    if (encToken) {
      // Best-effort — a failed revoke must not block disconnecting in-app; the token is cleared
      // from our DB regardless.
      await revokeRefreshToken(decrypt(encToken));
    }

    await sql`
      UPDATE "Researcher"
      SET "GoogleFormsRefreshTokenEnc" = NULL, "GoogleFormsEmail" = NULL, "GoogleFormsConnectedAt" = NULL
      WHERE "Id" = ${req.researcher.id}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[google-forms] disconnect error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
