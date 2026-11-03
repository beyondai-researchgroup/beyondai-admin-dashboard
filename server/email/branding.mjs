// Per-research branding of the emails a PARTICIPANT receives (Research.ShowBeyondAiBranding, 2026-11).
// Identical copy in admin-dashboard-andrejkatin, consent-andrejkatin, rei40-andrejkatin and bigfive-andrejkatin (same convention as mailer.mjs):
// keep all four the same.
//
// Branding on (the default, every research that existed before the switch): the sender / header name follows the usual chain
// EmailSenderName -> StudyDisplayName -> Name (null = the builder's own default), the footer keeps its contact line.
// Branding off: no BeyondAI anywhere. The header / From display name is the researcher's explicit EmailSenderName if one was typed,
// otherwise the neutral name below (the StudyDisplayName / Name steps are skipped on purpose), and the footer's contact line is dropped,
// because the contact address itself contains the word BeyondAI.

export const NEUTRAL_BRAND_NAME = 'Empirical Software Engineering Platform';

/**
 * @param {{ showBranding?: boolean|null, emailSenderName?: string|null, studyDisplayName?: string|null, name?: string|null }} p
 * @returns {{ senderName: string|null, hideContact: boolean }}
 */
export function resolveBranding({ showBranding, emailSenderName, studyDisplayName, name } = {}) {
  const explicit = (emailSenderName ?? '').trim();
  if (showBranding === false) return { senderName: explicit || NEUTRAL_BRAND_NAME, hideContact: true };
  return { senderName: explicit || (studyDisplayName ?? '').trim() || (name ?? '').trim() || null, hideContact: false };
}
