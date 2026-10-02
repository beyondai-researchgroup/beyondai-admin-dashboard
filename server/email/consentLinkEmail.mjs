// Builds the bilingual, branded HTML for the "here is your personal link to the consent form"
// email — sent when a researcher uploads a mailing-list CSV on the Consent Form page's delivery
// section (2026-09-08 follow-up, Part C3). Same visual template as regenerateLinksEmail.mjs/
// consentEmail.mjs, own copy per this project's established per-purpose duplication convention.
// Unlike those, there's exactly one link here (the CONSENT_ENTRY magic link into the Consent
// app itself, not a survey token) — a single button, not a list of questionnaire cards.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const COPY = {
  sr: {
    subject: 'Vaš lični link za istraživanje',
    preheader: 'Kliknite na link ispod da pristupite obrascu pristanka, važi 24h.',
    heading: 'Pozvani ste da učestvujete',
    intro: 'Kliknite na dugme ispod da pristupite obrascu informisanog pristanka za istraživanje.',
    buttonText: 'Otvori obrazac pristanka',
    expiry: 'Napomena: link važi 24 sata od trenutka slanja ovog mejla. Ako istekne, obratite se istraživaču za novi.',
    footer: 'Za sva pitanja, kontaktirajte nas na',
  },
  en: {
    subject: 'Your personal link to the research',
    preheader: 'Click the link below to access the consent form, valid for 24h.',
    heading: "You've been invited to participate",
    intro: 'Click the button below to access the informed consent form for the research.',
    buttonText: 'Open consent form',
    expiry: 'Note: this link is valid for 24 hours from when this email was sent. If it expires, contact the researcher for a new one.',
    footer: 'For any questions, contact us at',
  },
};

const DEFAULT_SENDER_NAME = 'BeyondAI Research Group';

/**
 * @param {'sr'|'en'} lang
 * @param {{ url: string, senderName?: string }} args
 * @returns {{ subject: string, html: string }}
 */
export function buildConsentLinkEmail(lang, { url, senderName }) {
  const t = COPY[lang] ?? COPY.sr;
  const brand = escapeHtml(senderName?.trim() || DEFAULT_SENDER_NAME);
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
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em;">${brand}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 16px;font-size:22px;color:#1a2e1a;">${t.heading}</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">${t.intro}</p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="padding:16px;background:#eaf2ec;border-radius:8px;" align="center">
                  <a href="${url}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">${t.buttonText}</a>
                </td>
              </tr>
            </table>

            <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">${t.expiry}</p>
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
