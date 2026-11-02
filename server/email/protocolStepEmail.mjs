// Builds the bilingual, branded HTML for a research-protocol step: either "here is your next step"
// (with a button to the step's link) or, for a message step, just the researcher's message.
// Same visual template as regenerateLinksEmail.mjs / consent-andrejkatin's consentEmail.mjs.
//
// Deliberately generic: it never names the instrument behind a step (REI-40 / Big Five / NASA-TLX /
// a questionnaire's topic) — a participant who knows which test is coming could look it up and prepare
// or skew their answers. The only research-specific text is the optional message the researcher wrote
// for that step (escaped, since it is free text rendered into HTML).

const COPY = {
  sr: {
    subjectStep: 'Sledeći korak u istraživanju',
    subjectMessage: 'Poruka u vezi sa istraživanjem',
    preheaderStep: 'Vaš lični link za sledeći korak istraživanja.',
    headingStep: 'Sledeći korak',
    headingMessage: 'Poruka istraživača',
    introStep: 'Molimo Vas da završite sledeći korak istraživanja pomoću dugmeta ispod.',
    buttonText: 'Otvori',
    expiry:
      'Napomena: link važi 7 dana od trenutka slanja ovog mejla. Ako istekne pre nego što završite, javite se istraživaču kako bi Vam poslao novi.',
    footer: 'Za sva pitanja, kontaktirajte nas na',
    windowBoth: 'Napomena: tabela se otvara {opens}, a dostupna je do {closes}. Link možete otvoriti i ranije, ali tabela počinje da radi tek kada nastupi to vreme.',
    windowOpens: 'Napomena: tabela se otvara {opens}. Link možete otvoriti i ranije, ali tabela počinje da radi tek kada nastupi to vreme.',
    windowCloses: 'Napomena: tabela je dostupna do {closes}.',
  },
  en: {
    subjectStep: 'Next step in the research',
    subjectMessage: 'A message about the research',
    preheaderStep: 'Your personal link to the next step of the research.',
    headingStep: 'Next step',
    headingMessage: 'A message from the researcher',
    introStep: 'Please complete the next step of the research using the button below.',
    buttonText: 'Open',
    expiry:
      'Note: the link is valid for 7 days from when this email was sent. If it expires before you finish, contact the researcher for a new one.',
    footer: 'For any questions, contact us at',
    windowBoth: 'Note: the table opens {opens} and is available until {closes}. You can open the link earlier, but the table only starts working once that time comes.',
    windowOpens: 'Note: the table opens {opens}. You can open the link earlier, but the table only starts working once that time comes.',
    windowCloses: 'Note: the table is available until {closes}.',
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DEFAULT_SENDER_NAME = 'BeyondAI Research Group';

/** A moment as people read it here: day, month, year and time in Belgrade. */
function formatMoment(date, lang) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'sr-Latn-RS', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Belgrade' }).format(date);
}

/** The note under the button: the availability window when there is one, else the usual 7-day validity. */
function noteFor(t, lang, window) {
  const opens = window?.opensAt ? formatMoment(window.opensAt, lang) : null;
  const closes = window?.closesAt ? formatMoment(window.closesAt, lang) : null;
  if (opens && closes) return t.windowBoth.replace('{opens}', opens).replace('{closes}', closes);
  if (opens) return t.windowOpens.replace('{opens}', opens);
  if (closes) return t.windowCloses.replace('{closes}', closes);
  return t.expiry;
}

/**
 * @param {'sr'|'en'} lang
 * @param {{ url?: string|null, message?: string|null, senderName?: string|null, window?: {opensAt: Date|null, closesAt: Date|null}|null }} args
 *   `url` present = a "next step" email with a button; absent = a plain message email.
 * @returns {{ subject: string, html: string }}
 */
export function buildProtocolStepEmail(lang, { url, message, senderName, window = null }) {
  const t = COPY[lang] ?? COPY.sr;
  const brand = escapeHtml(senderName?.trim() || DEFAULT_SENDER_NAME);
  const hasButton = !!url;
  const messageHtml = message && message.trim()
    ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;white-space:pre-line;">${escapeHtml(message.trim())}</p>`
    : '';
  const intro = hasButton ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">${t.introStep}</p>` : '';
  const button = hasButton
    ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="padding:16px;background:#eaf2ec;border-radius:8px;">
                  <a href="${escapeHtml(url)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;">${t.buttonText}</a>
                </td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">${escapeHtml(noteFor(t, lang, window))}</p>`
    : '';
  const html = `
<!doctype html>
<html lang="${lang}">
<body style="margin:0;padding:0;background:#f2f7f4;font-family:'Segoe UI',Arial,sans-serif;">
  <span style="display:none;font-size:1px;color:#f2f7f4;">${hasButton ? t.preheaderStep : ''}</span>
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
            <h1 style="margin:0 0 16px;font-size:22px;color:#1a2e1a;">${hasButton ? t.headingStep : t.headingMessage}</h1>
            ${messageHtml}
            ${intro}
            ${button}
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

  return { subject: hasButton ? t.subjectStep : t.subjectMessage, html };
}
