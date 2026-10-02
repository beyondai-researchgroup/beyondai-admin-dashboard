// Builds the bilingual, branded HTML for a "join this research" team invite (2026-09-08) — sent
// when an existing researcher account is added to a research they aren't already a member of,
// either by that research's OWNER (Configuration → Team) or by a superadmin (Researchers page).
// Same visual template as researcherInviteEmail.mjs/regenerateLinksEmail.mjs. The button leads to
// AcceptTeamInviteComponent (`/accept-team-invite/:token`), which grants access immediately on
// accept — the token alone is the authentication, same trust model as every other magic-link
// email in this platform (no login required to accept, confirmed explicit choice).

const COPY = {
  sr: {
    subject: (researchName) => `Poziv da se pridružite istraživanju "${researchName}"`,
    preheader: 'Pozvani ste da pristupite podacima jednog istraživanja.',
    heading: 'Pozivnica za istraživanje',
    intro: (researchName) =>
      `Pozvani ste da se pridružite istraživanju <strong>"${researchName}"</strong> na Admin Dashboard-u BeyondAI Research Group-a. Dok ne prihvatite poziv, nećete videti podatke ovog istraživanja. Kliknite na dugme ispod da prihvatite.`,
    buttonText: 'Prihvati poziv',
    expiry: 'Napomena: link važi 48 sati od trenutka slanja ovog mejla.',
    footer: 'Za sva pitanja, kontaktirajte nas na',
  },
  en: {
    subject: (researchName) => `Invitation to join the research "${researchName}"`,
    preheader: "You've been invited to access a research's data.",
    heading: 'Research invitation',
    intro: (researchName) =>
      `You've been invited to join the research <strong>"${researchName}"</strong> on the BeyondAI Research Group Admin Dashboard. You won't see this research's data until you accept the invitation. Click the button below to accept.`,
    buttonText: 'Accept invitation',
    expiry: 'Note: this link is valid for 48 hours from when this email was sent.',
    footer: 'For any questions, contact us at',
  },
};

/**
 * @param {'sr'|'en'} lang
 * @param {{ acceptUrl: string, researchName: string }} params
 * @returns {{ subject: string, html: string }}
 */
export function buildTeamInviteEmail(lang, { acceptUrl, researchName }) {
  const t = COPY[lang] ?? COPY.sr;
  const html = `
<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:0;background:#f2f7f4;font-family:'Segoe UI',Arial,sans-serif;">
  <span style="display:none;font-size:1px;color:#f2f7f4;">${t.preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f7f4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #c0dbc9;">
        <tr>
          <td style="background:#1a3a28;padding:24px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em;">BeyondAI Research Group</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 16px;font-size:22px;color:#1a2e1a;">${t.heading}</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">${t.intro(researchName)}</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td style="padding:16px;background:#eaf2ec;border-radius:8px;" align="center">
                  <a href="${acceptUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">${t.buttonText}</a>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">${t.expiry}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#6b7280;">${t.footer} <a href="mailto:beyondai.researchgroup@gmail.com" style="color:#16a34a;">beyondai.researchgroup@gmail.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  return { subject: t.subject(researchName), html };
}
