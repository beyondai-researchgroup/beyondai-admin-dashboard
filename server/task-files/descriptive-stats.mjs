import { parse } from 'csv-parse/sync';

function isNumeric(v) {
  if (v === null || v === undefined || v === '') return false;
  return Number.isFinite(Number(v));
}

function numericStats(values) {
  const nums = values.filter(isNumeric).map(Number);
  const count = nums.length;
  if (count === 0) return { count: 0, mean: null, stddev: null, min: null, max: null };
  const mean = nums.reduce((a, b) => a + b, 0) / count;
  const variance = count > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1) : 0;
  return {
    count,
    mean: Number(mean.toFixed(4)),
    stddev: Number(Math.sqrt(variance).toFixed(4)),
    min: Math.min(...nums),
    max: Math.max(...nums),
  };
}

// Value → count, sorted by DESCENDING count — right for CHOICE, where the values are unordered
// categories and "most picked first" is what a researcher wants to scan.
function frequencyTable(values) {
  const counts = new Map();
  let nonEmpty = 0;
  for (const v of values) {
    const s = (v ?? '').toString().trim();
    if (!s) continue;
    nonEmpty++;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return {
    count: nonEmpty,
    frequencies: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
  };
}

// Value → count, sorted by ASCENDING numeric value — right for NUMBER/LIKERT, where the values
// have a natural order and a distribution chart should read left-to-right low-to-high (e.g. a
// Likert 1..5 bar chart), not shuffled by popularity.
function numericFrequencyTable(values) {
  const counts = new Map();
  for (const v of values) {
    if (!isNumeric(v)) continue;
    const n = Number(v);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value: String(value), count }));
}

const MAX_SAMPLE_ANSWERS = 300;

/**
 * Descriptive statistics for an uploaded survey-results CSV (Part G of the platform
 * re-architecture, 2026-09-07; extended 2026-09-08 with per-column `frequencies` for
 * NUMBER/LIKERT — powers the master-detail table's per-question distribution chart — and
 * `sampleAnswers` for TEXT, since free text has nothing to chart but is still worth reading
 * per-response). `questions` is the research's TaskFormQuestion rows — a column with no matching
 * question still gets a best-effort summary (numeric stats if most of its values parse as
 * numbers, else a bare non-empty count) rather than being silently dropped, so an un-mapped
 * column is still visible, just without a friendly label.
 *
 * `idColumnKey` (2026-09-08 follow-up), when given, additionally returns the raw (trimmed,
 * non-empty) values of that one column as `participantIdValues` — the caller uses this to match
 * survey rows back to imported `Participant` rows; every other column stays aggregate-only, this
 * is the only place a single response's raw value ever leaves this function.
 *
 * @param {string} csvText
 * @param {{columnKey: string, label: string, questionType: 'NUMBER'|'TEXT'|'LIKERT'|'CHOICE'}[]} questions
 * @param {string | null} [idColumnKey]
 */
export function computeDescriptiveStats(csvText, questions, idColumnKey = null) {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (!rows.length) return { rowCount: 0, columns: [], participantIdValues: [] };

  const headers = Object.keys(rows[0]);
  const byKey = new Map(questions.map((q) => [q.columnKey, q]));
  const columns = [];

  for (const header of headers) {
    const values = rows.map((r) => r[header]);
    const q = byKey.get(header);

    if (q && (q.questionType === 'NUMBER' || q.questionType === 'LIKERT')) {
      columns.push({
        columnKey: header, label: q.label, questionType: q.questionType, mapped: true,
        ...numericStats(values), frequencies: numericFrequencyTable(values),
      });
    } else if (q && q.questionType === 'CHOICE') {
      columns.push({ columnKey: header, label: q.label, questionType: 'CHOICE', mapped: true, ...frequencyTable(values) });
    } else if (q && q.questionType === 'TEXT') {
      const sampleAnswers = values.map((v) => (v ?? '').toString().trim()).filter(Boolean).slice(0, MAX_SAMPLE_ANSWERS);
      columns.push({ columnKey: header, label: q.label, questionType: 'TEXT', mapped: true, count: sampleAnswers.length, sampleAnswers });
    } else {
      // No mapped question for this column — best-effort: numeric if most values parse, else a
      // bare non-empty count. Label falls back to the raw header, mapped:false lets the frontend
      // show it distinctly (e.g. "unlabeled column" hint).
      const numericRate = values.filter(isNumeric).length / values.length;
      if (numericRate >= 0.8) {
        columns.push({
          columnKey: header, label: header, questionType: 'NUMBER', mapped: false,
          ...numericStats(values), frequencies: numericFrequencyTable(values),
        });
      } else {
        const sampleAnswers = values.map((v) => (v ?? '').toString().trim()).filter(Boolean).slice(0, MAX_SAMPLE_ANSWERS);
        columns.push({ columnKey: header, label: header, questionType: 'TEXT', mapped: false, count: sampleAnswers.length, sampleAnswers });
      }
    }
  }

  const participantIdValues = idColumnKey && headers.includes(idColumnKey)
    ? rows.map((r) => (r[idColumnKey] ?? '').toString().trim()).filter(Boolean)
    : [];

  return { rowCount: rows.length, columns, participantIdValues };
}

/**
 * Finds the one CSV row (if any) belonging to a specific participant, matched by the
 * designated ID column — the per-participant counterpart to computeDescriptiveStats' aggregate
 * view, powering Participant Detail's "Odgovori na anketu" section (2026-09-08 follow-up).
 * Returns the ID column itself excluded from `answers` (it's identity, not a response).
 *
 * @param {string} csvText
 * @param {string} idColumnKey
 * @param {string} participantId
 * @param {{columnKey: string, label: string}[]} questions
 * @returns {{columnKey: string, label: string, value: string}[] | null}
 */
export function findParticipantRow(csvText, idColumnKey, participantId, questions) {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (!rows.length) return null;
  const byKey = new Map(questions.map((q) => [q.columnKey, q.label]));
  const match = rows.find((r) => (r[idColumnKey] ?? '').toString().trim() === participantId);
  if (!match) return null;
  return Object.keys(match)
    .filter((header) => header !== idColumnKey)
    .map((header) => ({ columnKey: header, label: byKey.get(header) ?? header, value: (match[header] ?? '').toString() }));
}
