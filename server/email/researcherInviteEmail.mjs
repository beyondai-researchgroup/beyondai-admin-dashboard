// Builds the bilingual, branded HTML for a new researcher's account-invite email (researcher
// profile system, 2026-08-20). Same visual template as regenerateLinksEmail.mjs/
// consent-andrejkatin's consentEmail.mjs — link-only, confirmed explicit choice: no plaintext
// password is ever emailed. The button leads to AcceptInviteComponent (`/accept-invite/:token`),
// which authenticates via the one-time token itself and lets the researcher set their own
// password before ever logging in.

const COPY = {
  sr: {
    subject: 'Pozivnica - BeyondAI Research Group Admin Dashboard',
    preheader: 'Nalog je kreiran za Vas - postavite lozinku da biste pristupili.',
    heading: 'Dobrodošli',
    intro:
      'Kreiran je nalog za Vas na Admin Dashboard-u BeyondAI Research Group-a. Kliknite na dugme ispod da postavite svoju lozinku i pristupite nalogu.',
    buttonText: 'Prihvati poziv i postavi lozinku',
    expiry: 'Napomena: link važi 48 sati od trenutka slanja ovog mejla.',
    footer: 'Za sva pitanja, kontaktirajte nas na',
  },
  en: {
    subject: 'Invitation - BeyondAI Research Group Admin Dashboard',
    preheader: 'An account has been created for you - set your password to access it.',
    heading: 'Welcome',
    intro:
      "An account has been created for you on the BeyondAI Research Group Admin Dashboard. Click the button below to set your password and access your account.",
    buttonText: 'Accept invite & set password',
    expiry: 'Note: this link is valid for 48 hours from when this email was sent.',
    footer: 'For any questions, contact us at',
  },
};

/**
 * @param {'sr'|'en'} lang
 * @param {{ acceptUrl: string }} params
 * @returns {{ subject: string, html: string }}
 */
export function buildResearcherInviteEmail(lang, { acceptUrl }) {
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
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">${t.intro}</p>

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

  return { subject: t.subject, html };
}
