import { forms as googleForms } from '@googleapis/forms';
import { clientForRefreshToken } from './oauth.mjs';

/**
 * Extracts a Google Form's id from any of the URL shapes Google actually hands out
 * (`.../forms/d/<id>/edit`, `.../forms/d/e/<publishedId>/viewform`, or a bare id already).
 * Returns null if nothing recognizable is found.
 */
export function extractFormId(urlOrId) {
  if (!urlOrId) return null;
  const trimmed = String(urlOrId).trim();
  const match = trimmed.match(/\/forms\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Already looks like a bare id (no slashes/spaces) — accept as-is.
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Maps one Google Forms API question item to our own QuestionType allowlist
 * ('NUMBER'|'TEXT'|'LIKERT'|'CHOICE'). The Forms API has no distinct "number" question type of
 * its own (short-answer text with number validation is still textQuestion under the hood, and
 * that validation detail isn't reliably exposed) — such items land as TEXT by default; a
 * researcher can manually reclassify any row afterward, since Google-sourced rows are stored as
 * regular editable TaskFormQuestion rows, not read-only.
 */
function mapQuestionType(question) {
  if (question.scaleQuestion) return 'LIKERT';
  if (question.choiceQuestion) return 'CHOICE';
  return 'TEXT';
}

/**
 * Reads a Google Form's live question structure via the Forms API, using the given researcher's
 * own connected refresh token — Part G of the platform re-architecture (2026-09-07). Only
 * question items (`questionItem`) are extracted; layout items (section headers, images, page
 * breaks) are skipped, they have nothing to map to a descriptive-stats column.
 *
 * Throws on any Google API error (a 403 means the connected account doesn't have access to this
 * specific form — most common cause: the form belongs to someone else's account) — the caller
 * surfaces this as a clear error rather than silently returning an empty list.
 */
export async function readFormStructure(refreshToken, formId) {
  const auth = clientForRefreshToken(refreshToken);
  const forms = googleForms({ version: 'v1', auth });
  const { data } = await forms.forms.get({ formId });

  const questions = [];
  let sortOrder = 0;
  for (const item of data.items ?? []) {
    const q = item.questionItem?.question;
    if (!q) continue; // not a question item (section header, image, page break, etc.)
    questions.push({
      columnKey: item.title ?? `Item ${item.itemId}`,
      label: item.title ?? `Item ${item.itemId}`,
      questionType: mapQuestionType(q),
      sortOrder: sortOrder++,
    });
  }
  return questions;
}
