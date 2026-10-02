import { parse } from 'csv-parse/sync';

const CSV_EXTENSION = /\.csv$/i;
// Reject a CSV whose header row shares fewer than half of the research's already-described
// form questions — almost certainly the wrong survey's export dumped in by mistake, rather than
// this research's own results. A partial mismatch (extra Google-added columns like "Timestamp",
// or a few unmapped columns) is still tolerated — only a mostly-different header set is rejected.
const MISMATCH_THRESHOLD = 0.5;

export function isCsvFilename(filename) {
  return CSV_EXTENSION.test(filename || '');
}

/**
 * Validates uploaded files against the Google Forms task type's two rules (2026-09-08 follow-up):
 * (1) only .csv files are accepted at all for this task type's results upload — anything else is
 * rejected outright, before any DB write; (2) if the research already has a described form
 * structure (TaskFormQuestion rows — via OAuth read or manual entry), a CSV whose header row
 * doesn't share at least half of those columns is very likely the WRONG survey's export and is
 * rejected rather than silently accepted and producing garbage/near-empty descriptive stats. With
 * no described structure yet, rule (2) has nothing to compare against and is skipped — matches
 * this codebase's established "never block on a missing optional prerequisite" convention.
 *
 * Pure and synchronous — no DB/network access — so the route handler stays the only place that
 * decides what to do with the result (reject the whole batch, nothing partially inserted).
 *
 * @param {{originalname: string, buffer: Buffer}[]} files
 * @param {{columnKey: string}[]} questions - the research's current TaskFormQuestion rows (may be empty)
 * @returns {{ok: true} | {ok: false, errors: {filename: string, reason: string, matched?: number, total?: number}[]}}
 */
export function validateGoogleFormsUpload(files, questions) {
  const errors = [];
  const knownKeys = new Set(questions.map((q) => q.columnKey));

  for (const file of files) {
    if (!isCsvFilename(file.originalname)) {
      errors.push({ filename: file.originalname, reason: 'NOT_CSV' });
      continue;
    }

    if (knownKeys.size === 0) continue; // no described structure yet — nothing to compare against

    let headers;
    try {
      const rows = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
      headers = rows.length ? Object.keys(rows[0]) : [];
    } catch {
      errors.push({ filename: file.originalname, reason: 'CSV_PARSE_ERROR' });
      continue;
    }

    const headerSet = new Set(headers);
    const total = knownKeys.size;
    const matched = [...knownKeys].filter((k) => headerSet.has(k)).length;
    if (matched / total < MISMATCH_THRESHOLD) {
      errors.push({ filename: file.originalname, reason: 'FORM_MISMATCH', matched, total });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
