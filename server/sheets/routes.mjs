import { Router } from 'express';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { ZipArchive } from 'archiver';
import { translateTexts, translationConfigured, TranslationError, needsTranslation } from '../translate/translator.mjs';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { sendMail } from '../email/mailer.mjs';
import { resolveBranding } from '../email/branding.mjs';
import { enqueueMail, kickOutbox } from '../email/outbox.mjs';
import { buildProtocolStepEmail } from '../email/protocolStepEmail.mjs';
import { loadWorkbookSlots, pickWorkbook, upsertSheetLink, loadSheetsWindow, sheetLinkExpiry } from './resolve.mjs';

// Admin side of the "sheets" app (sheets-andrejkatin, 2026-10): who has a personal link / a draft / a
// submitted table, link minting + emailing, a read-only view of one participant's table and the Excel
// export. The template itself is designed in the sheets app (researcher login); everything here is gated by
// Research.UsesSheets and by the usual research scope + OWNER/COLLABORATOR role for actions that write.
// Own router at its own base path, like the other results/feature routers.
const router = Router();
router.use(requireAuth);

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];
const MAX_BULK = 200;

const appUrl = () => (process.env.SHEETS_APP_URL || 'http://localhost:4307').replace(/\/$/, '');

function scopeGuard(req, res, id) {
  try {
    resolveResearchScope(req.researcher, id);
    return true;
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

function parseId(req, res) {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return null;
  }
  return scopeGuard(req, res, id) ? id : null;
}

function requireWrite(req, res, researchId) {
  if (!hasMinRole(req.researcher, researchId, WRITE_ROLES)) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return false;
  }
  return true;
}

async function loadResearch(sql, researchId) {
  const rows = await sql`SELECT "Id","Name","UsesSheets","StudyDisplayName","EmailSenderName","SheetsTimerMinutes","SheetsMinSubmitMinutes","ShowBeyondAiBranding","MailRelayKey" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
  return rows[0] ?? null;
}

/** One template of the research by id (full content), or null. */
async function loadWorkbookById(sql, researchId, workbookId) {
  const rows = await sql`
    SELECT "Id","Label","Title","Snapshot","Rules","Version","UpdatedAt","InstructionsSr","InstructionsEn","GroupId","ResearchTaskId"
    FROM "SheetWorkbook" WHERE "ResearchId" = ${researchId} AND "Id" = ${workbookId} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** A participant of this research with the group and task that decide their template, and the template itself (null: none fits). */
async function loadParticipantWithTemplate(sql, researchId, participantId) {
  const rows = await sql`
    SELECT "Guid","ParticipantId","Email","Language","GroupId","ResearchTaskId"
    FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantId" = ${participantId} LIMIT 1
  `;
  if (!rows[0]) return null;
  const workbooks = await loadWorkbookSlots(sql, researchId);
  return { participant: rows[0], workbook: pickWorkbook(workbooks, rows[0].GroupId, rows[0].ResearchTaskId) };
}

/** Plain text of a Univer cell (plain value, or the data stream of a rich-text cell). */
function cellText(cell) {
  if (!cell) return '';
  if (cell.v !== undefined && cell.v !== null) return String(cell.v);
  const stream = cell.p?.body?.dataStream;
  return typeof stream === 'string' ? stream.replace(/\r?\n$/, '').replace(/\r\n/g, '\n') : '';
}

const columnLetter = (col) => {
  let n = col; let out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
};

async function mintLink(sql, workbookId, participantGuid, window) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = sheetLinkExpiry(window, TOKEN_TTL_MS);
  await upsertSheetLink(sql, { token, workbookId, participantGuid, expiresAt });
  return { url: `${appUrl()}/link/${token}`, expiresAt };
}

/** Queues the link mail (bulk sends go through the outbox, so the relay's daily limit is respected). */
async function queueLink(sql, research, participant, url, window) {
  const lang = participant.Language === 'en' ? 'en' : 'sr';
  const branding = resolveBranding({ showBranding: research.ShowBeyondAiBranding, emailSenderName: research.EmailSenderName, studyDisplayName: research.StudyDisplayName, name: research.Name });
  const senderName = branding.senderName ?? research.Name;
  const { subject, html } = buildProtocolStepEmail(lang, { url, message: null, senderName, hideContact: branding.hideContact, window, kind: 'TASK' });
  await enqueueMail(sql, { researchId: research.Id, participantGuid: participant.Guid, to: participant.Email, subject, html, fromName: senderName });
}

async function emailLink(research, participant, url, window) {
  const lang = participant.Language === 'en' ? 'en' : 'sr';
  const branding = resolveBranding({ showBranding: research.ShowBeyondAiBranding, emailSenderName: research.EmailSenderName, studyDisplayName: research.StudyDisplayName, name: research.Name });
  const senderName = branding.senderName ?? research.Name;
  const { subject, html } = buildProtocolStepEmail(lang, { url, message: null, senderName, hideContact: branding.hideContact, window, kind: 'TASK' });
  await sendMail({ to: participant.Email, subject, html, fromName: senderName, relayKey: research.MailRelayKey ?? undefined });
}

// ── overview: templates, and every participant with the template they get, link and entry status ─────
router.get('/:researchId', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const research = await loadResearch(sql, researchId);
    if (!research) { res.status(404).json({ error: 'Research not found' }); return; }
    const win = await loadSheetsWindow(sql, researchId);
    const groupRows = await sql`SELECT "Id","Name" FROM "ResearchGroup" WHERE "ResearchId" = ${researchId} ORDER BY "Id"`;
    const base = {
      groups: groupRows.map((g) => ({ id: g.Id, name: g.Name })),
      usesSheets: research.UsesSheets, appUrl: appUrl(), canWrite: hasMinRole(req.researcher, researchId, WRITE_ROLES),
      window: { opensAt: win.opensAt?.toISOString() ?? null, closesAt: win.closesAt?.toISOString() ?? null },
      // The countdown (minutes) that runs from the moment a participant presses Start; null = none.
      timerMinutes: research.SheetsTimerMinutes ?? null,
      // The earliest the participant may hand in, counted from Start (null = any time).
      minSubmitMinutes: research.SheetsMinSubmitMinutes ?? null,
    };
    const workbooks = await sql`
      SELECT w."Id", w."Label", w."Title", w."Version", w."UpdatedAt", w."GroupId", w."ResearchTaskId", w."Rules", w."InstructionsSr", w."InstructionsEn",
             g."Name" AS "GroupName", t."Name" AS "TaskName",
             (SELECT COUNT(*)::int FROM "SheetEntry" e WHERE e."WorkbookId" = w."Id") AS "Entries",
             (SELECT COUNT(*)::int FROM "SheetEntry" e WHERE e."WorkbookId" = w."Id" AND e."Status" = 'SUBMITTED') AS "Submitted"
      FROM "SheetWorkbook" w LEFT JOIN "ResearchGroup" g ON g."Id" = w."GroupId" LEFT JOIN "ResearchTask" t ON t."Id" = w."ResearchTaskId"
      WHERE w."ResearchId" = ${researchId} ORDER BY w."SortOrder", w."Id"
    `;
    const summaries = workbooks.map((w) => ({
      id: w.Id, label: w.Label, title: w.Title, version: w.Version, updatedAt: w.UpdatedAt,
      groupId: w.GroupId, groupName: w.GroupName ?? null, taskId: w.ResearchTaskId, taskName: w.TaskName ?? null,
      sheetCount: Object.keys(w.Rules?.sheets ?? {}).length,
      hasRules: !!(w.InstructionsSr?.trim() || w.InstructionsEn?.trim()),
      entryCount: w.Entries, submittedCount: w.Submitted,
    }));
    if (!workbooks.length) { res.json({ ...base, workbook: null, workbooks: [], participants: [] }); return; }

    const [people, links, entries] = await Promise.all([
      sql`
        SELECT p."Guid", p."ParticipantId", p."Email", p."Language", p."GroupId", p."ResearchTaskId", g."Name" AS "GroupName", t."Name" AS "TaskName"
        FROM "Participant" p LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId" LEFT JOIN "ResearchTask" t ON t."Id" = p."ResearchTaskId"
        WHERE p."ResearchId" = ${researchId} ORDER BY p."ParticipantId"
      `,
      sql`
        SELECT l."ParticipantGuid", l."WorkbookId", l."Token", l."ExpiresAt", l."RulesAcknowledgedAt" FROM "SheetAccessLink" l
        JOIN "SheetWorkbook" w ON w."Id" = l."WorkbookId" WHERE w."ResearchId" = ${researchId}
      `,
      sql`
        SELECT e."ParticipantGuid", e."WorkbookId", e."Status", e."UpdatedAt", e."SubmittedAt", e."IsTimedOut" FROM "SheetEntry" e
        JOIN "SheetWorkbook" w ON w."Id" = e."WorkbookId" WHERE w."ResearchId" = ${researchId}
      `,
    ]);
    const linkBy = new Map(links.map((l) => [`${l.ParticipantGuid}:${l.WorkbookId}`, l]));
    const entryBy = new Map(entries.map((e) => [`${e.ParticipantGuid}:${e.WorkbookId}`, e]));
    const anyLink = new Map(links.map((l) => [l.ParticipantGuid, l]));
    const anyEntry = new Map(entries.map((e) => [e.ParticipantGuid, e]));
    const now = Date.now();
    res.json({
      ...base,
      workbook: summaries[0], // the first template, for callers that still expect one
      workbooks: summaries,
      participants: people.map((r) => {
        const wb = pickWorkbook(workbooks, r.GroupId, r.ResearchTaskId);
        const l = (wb && linkBy.get(`${r.Guid}:${wb.Id}`)) ?? anyLink.get(r.Guid);
        const e = (wb && entryBy.get(`${r.Guid}:${wb.Id}`)) ?? anyEntry.get(r.Guid);
        // Timing: the start is the moment the participant pressed "Start task"; the time is up when the countdown ran out without a hand-in.
        const started = l?.RulesAcknowledgedAt ? new Date(l.RulesAcknowledgedAt).getTime() : null;
        const timerMs = research.SheetsTimerMinutes ? research.SheetsTimerMinutes * 60_000 : null;
        const submitted = e?.Status === 'SUBMITTED';
        const durationMin = submitted && started && e.SubmittedAt ? Math.max(0, Math.round((new Date(e.SubmittedAt).getTime() - started) / 60_000)) : null;
        const timeUp = !!(timerMs && started && !submitted && now > started + timerMs);
        return {
          participantId: r.ParticipantId,
          hasEmail: !!r.Email,
          language: r.Language,
          groupName: r.GroupName ?? null,
          taskName: r.TaskName ?? null,
          workbookId: wb?.Id ?? null,
          workbookLabel: wb ? (wb.Label || wb.Title) : null,
          noTemplate: !wb,
          link: l ? { url: `${appUrl()}/link/${l.Token}`, expiresAt: l.ExpiresAt, expired: new Date(l.ExpiresAt).getTime() <= now } : null,
          rulesAcknowledgedAt: l?.RulesAcknowledgedAt ?? null,
          startedAt: l?.RulesAcknowledgedAt ?? null,
          timeUp,
          entry: e ? { status: e.Status, updatedAt: e.UpdatedAt, submittedAt: e.SubmittedAt, timedOut: !!e.IsTimedOut, durationMin } : null,
        };
      }),
    });
  } catch (err) {
    console.error('[sheets] overview error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── availability window ─────────────────────────────────────────────────────────────────────────────
// When the tables of this research open and close. Both optional (null = no limit on that side). The sheets app enforces it
// on every request of a participant's link, so an emailed link can be sent early and still opens the table only in time.
router.put('/:researchId/window', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const toDate = (v) => {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const opensAt = toDate(req.body?.opensAt);
  const closesAt = toDate(req.body?.closesAt);
  if (opensAt === undefined || closesAt === undefined) { res.status(400).json({ error: 'INVALID_DATE' }); return; }
  if (opensAt && closesAt && opensAt >= closesAt) { res.status(400).json({ error: 'WINDOW_ORDER' }); return; }
  // The countdown is optional in the body: a caller that does not send it leaves it as it is.
  const hasTimer = req.body && Object.prototype.hasOwnProperty.call(req.body, 'timerMinutes');
  let timerMinutes = null;
  if (hasTimer && req.body.timerMinutes != null && req.body.timerMinutes !== '') {
    timerMinutes = Number(req.body.timerMinutes);
    if (!Number.isInteger(timerMinutes) || timerMinutes < 1 || timerMinutes > 480) { res.status(400).json({ error: 'INVALID_TIMER' }); return; }
  }
  const hasMin = req.body && Object.prototype.hasOwnProperty.call(req.body, 'minSubmitMinutes');
  let minSubmitMinutes = null;
  if (hasMin && req.body.minSubmitMinutes != null && req.body.minSubmitMinutes !== '') {
    minSubmitMinutes = Number(req.body.minSubmitMinutes);
    if (!Number.isInteger(minSubmitMinutes) || minSubmitMinutes < 1 || minSubmitMinutes > 479) { res.status(400).json({ error: 'INVALID_MIN_SUBMIT' }); return; }
  }
  try {
    const sql = getDb();
    const research = await loadResearch(sql, researchId);
    if (!research) { res.status(404).json({ error: 'Research not found' }); return; }
    // The hand-in cannot open later than the countdown ends, or the participant could never hand in by hand.
    const effTimer = hasTimer ? timerMinutes : (research.SheetsTimerMinutes ?? null);
    const effMin = hasMin ? minSubmitMinutes : (research.SheetsMinSubmitMinutes ?? null);
    if (effMin != null && effTimer != null && effMin >= effTimer) { res.status(400).json({ error: 'MIN_SUBMIT_AFTER_TIMER' }); return; }
    if (hasMin) await sql`UPDATE "Research" SET "SheetsMinSubmitMinutes" = ${minSubmitMinutes} WHERE "Id" = ${researchId}`;
    await sql`UPDATE "Research" SET "SheetsOpensAt" = ${opensAt?.toISOString() ?? null}, "SheetsClosesAt" = ${closesAt?.toISOString() ?? null} WHERE "Id" = ${researchId}`;
    if (hasTimer) await sql`UPDATE "Research" SET "SheetsTimerMinutes" = ${timerMinutes} WHERE "Id" = ${researchId}`;
    // A link already sent must not run out before the table closes.
    if (closesAt) {
      await sql`
        UPDATE "SheetAccessLink" l SET "ExpiresAt" = ${closesAt.toISOString()}
        WHERE l."WorkbookId" IN (SELECT "Id" FROM "SheetWorkbook" WHERE "ResearchId" = ${researchId}) AND l."ExpiresAt" < ${closesAt.toISOString()}
      `;
    }
    res.json({ ok: true, opensAt: opensAt?.toISOString() ?? null, closesAt: closesAt?.toISOString() ?? null, ...(hasTimer ? { timerMinutes } : {}), ...(hasMin ? { minSubmitMinutes } : {}) });
  } catch (err) {
    console.error('[sheets] window error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── mint (and optionally email) a participant's personal link ───────────────────────────────────────
async function prepare(req, res, researchId) {
  if (!requireWrite(req, res, researchId)) return null;
  const sql = getDb();
  const research = await loadResearch(sql, researchId);
  if (!research) { res.status(404).json({ error: 'Research not found' }); return null; }
  if (!research.UsesSheets) { res.status(403).json({ error: 'NOT_ENABLED' }); return null; }
  return { sql, research };
}

router.post('/:researchId/participants/:participantId/link', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const ctx = await prepare(req, res, researchId);
    if (!ctx) return;
    const { sql, research } = ctx;
    const found = await loadParticipantWithTemplate(sql, researchId, String(req.params.participantId));
    if (!found) { res.status(404).json({ error: 'Participant not found' }); return; }
    const { participant: p, workbook: wb } = found;
    if (!wb) { res.status(400).json({ error: 'NO_TEMPLATE' }); return; }
    const submitted = (await sql`SELECT 1 FROM "SheetEntry" WHERE "WorkbookId" = ${wb.Id} AND "ParticipantGuid" = ${p.Guid} AND "Status" = 'SUBMITTED'`).length > 0;
    if (submitted) { res.status(409).json({ error: 'ALREADY_SUBMITTED' }); return; }
    const send = req.body?.send === true;
    if (send && !p.Email) { res.status(400).json({ error: 'NO_EMAIL' }); return; }
    const win = await loadSheetsWindow(sql, researchId);
    const link = await mintLink(sql, wb.Id, p.Guid, win);
    if (send) {
      try {
        await emailLink(research, p, link.url, win);
      } catch (err) {
        console.error('[sheets] email failed:', err);
        res.status(502).json({ ok: false, error: 'EMAIL_FAILED', url: link.url });
        return;
      }
    }
    res.json({ ok: true, url: link.url, expiresAt: link.expiresAt, sent: send });
  } catch (err) {
    console.error('[sheets] link error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Bulk: mint + email a link to every participant that has an email and has not submitted yet.
router.post('/:researchId/links', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const ctx = await prepare(req, res, researchId);
    if (!ctx) return;
    const { sql, research } = ctx;
    const ids = Array.isArray(req.body?.participantIds) ? req.body.participantIds.map(String) : null;
    if (ids && ids.length > MAX_BULK) { res.status(400).json({ error: `At most ${MAX_BULK} participants at a time` }); return; }
    const workbooks = await loadWorkbookSlots(sql, researchId);
    if (!workbooks.length) { res.status(400).json({ error: 'NO_WORKBOOK' }); return; }
    const rows = await sql`
      SELECT p."Guid", p."ParticipantId", p."Email", p."Language", p."GroupId", p."ResearchTaskId"
      FROM "Participant" p WHERE p."ResearchId" = ${researchId} ORDER BY p."ParticipantId"
    `;
    const targets = (ids ? rows.filter((r) => ids.includes(r.ParticipantId)) : rows).slice(0, MAX_BULK);
    const submittedKeys = new Set((await sql`
      SELECT e."ParticipantGuid", e."WorkbookId" FROM "SheetEntry" e JOIN "SheetWorkbook" w ON w."Id" = e."WorkbookId"
      WHERE w."ResearchId" = ${researchId} AND e."Status" = 'SUBMITTED'
    `).map((e) => `${e.ParticipantGuid}:${e.WorkbookId}`));
    const win = await loadSheetsWindow(sql, researchId);
    const result = { sent: 0, skippedNoEmail: 0, skippedSubmitted: 0, skippedNoTemplate: 0, failed: [] };
    for (const p of targets) {
      const wb = pickWorkbook(workbooks, p.GroupId, p.ResearchTaskId);
      if (!wb) { result.skippedNoTemplate++; continue; }
      if (submittedKeys.has(`${p.Guid}:${wb.Id}`)) { result.skippedSubmitted++; continue; }
      if (!p.Email) { result.skippedNoEmail++; continue; }
      try {
        const link = await mintLink(sql, wb.Id, p.Guid, win);
        await queueLink(sql, research, p, link.url, win);
        result.sent++;
      } catch (err) {
        console.error('[sheets] bulk email failed for', p.ParticipantId, err);
        result.failed.push(p.ParticipantId);
      }
    }
    await kickOutbox(sql);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[sheets] bulk link error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── one participant's table, read-only ──────────────────────────────────────────────────────────────
function describeSheets(wb, rowsBySheet) {
  const order = wb.Snapshot.sheetOrder ?? Object.keys(wb.Snapshot.sheets);
  return order.filter((id) => wb.Rules.sheets[id]).map((id) => {
    const rules = wb.Rules.sheets[id];
    const rows = rowsBySheet?.[id] ?? {};
    return {
      id,
      name: wb.Snapshot.sheets[id]?.name ?? id,
      headerRows: rules.headerRows,
      columns: rules.columns.map((c) => ({ index: c.index, title: c.title || columnLetter(c.index), required: c.required })),
      rows: Object.keys(rows).map(Number).sort((a, b) => a - b).map((r) => ({ row: r, cells: rows[r] })),
    };
  });
}

router.get('/:researchId/participants/:participantId/entry', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT e."Rows", e."Status", e."UpdatedAt", e."SubmittedAt", e."WorkbookId", e."IsTimedOut", l."RulesAcknowledgedAt"
      FROM "SheetEntry" e JOIN "Participant" p ON p."Guid" = e."ParticipantGuid"
      JOIN "SheetWorkbook" w ON w."Id" = e."WorkbookId"
      LEFT JOIN "SheetAccessLink" l ON l."ParticipantGuid" = e."ParticipantGuid" AND l."WorkbookId" = e."WorkbookId"
      WHERE w."ResearchId" = ${researchId} AND p."ResearchId" = ${researchId} AND p."ParticipantId" = ${String(req.params.participantId)}
      ORDER BY e."UpdatedAt" DESC LIMIT 1
    `;
    const e = rows[0];
    if (!e) { res.status(404).json({ error: 'NO_ENTRY' }); return; }
    const wb = await loadWorkbookById(sql, researchId, e.WorkbookId);
    if (!wb) { res.status(404).json({ error: 'NO_WORKBOOK' }); return; }
    const startedMs = e.RulesAcknowledgedAt ? new Date(e.RulesAcknowledgedAt).getTime() : null;
    const durationMin = e.Status === 'SUBMITTED' && startedMs && e.SubmittedAt ? Math.max(0, Math.round((new Date(e.SubmittedAt).getTime() - startedMs) / 60_000)) : null;
    res.json({ title: wb.Label || wb.Title, status: e.Status, updatedAt: e.UpdatedAt, submittedAt: e.SubmittedAt, rulesAcknowledgedAt: e.RulesAcknowledgedAt ?? null, timedOut: !!e.IsTimedOut, durationMin, sheets: describeSheets(wb, e.Rows) });
  } catch (err) {
    console.error('[sheets] entry error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Excel export ────────────────────────────────────────────────────────────────────────────────────
// One worksheet per template sheet: the template's header (merged cells included) with a ParticipantId column in
// front and a Status column at the end, then one row per filled row of every participant. All templates of the research
// go into one file (each sheet name starts with the template's label), or just one with ?workbookId=.
// `tr` (default: no change) is applied to every text that ends up in the file: header cells, sheet names, group / task / template
// names and the participants' answers. The ZIP export uses it to translate the whole file.
const same = (s) => s;
function addWorkbookSheets(book, wb, entries, { hasCodes, hasGroups, hasTasks, hasTimer, prefix, withTemplate, tr = same }, usedNames) {
  const hasRules = !!(wb.InstructionsSr?.trim() || wb.InstructionsEn?.trim());
  const order = wb.Snapshot.sheetOrder ?? Object.keys(wb.Snapshot.sheets);
  for (const id of order) {
    const rules = wb.Rules.sheets[id];
    const snap = wb.Snapshot.sheets[id];
    if (!rules || !snap) continue;
    // the label is shortened, not the sheet name: Excel cuts sheet names at 31 characters
    const raw = prefix ? `${tr(prefix).slice(0, 18)} - ${tr(String(snap.name || id))}` : tr(String(snap.name || id));
    let name = raw.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || id;
    while (usedNames.has(name.toLowerCase())) name = `${name.slice(0, 28)}_${usedNames.size}`;
    usedNames.add(name.toLowerCase());
    const ws = book.addWorksheet(name);
    const cols = Math.max(snap.columnCount ?? 0, ...rules.columns.map((c) => c.index + 1));
    const statusCol = cols + 2; // ParticipantId is column 1, template columns follow, then Status (1-based)
    // After Status, in this order, only the columns that apply: Group, Task, Template, RulesAcknowledged.
    const extras = [];
    if (hasCodes) extras.push({ header: 'Code', width: 10, value: (e) => e.ParticipantCode ?? '' });
    if (hasGroups) extras.push({ header: 'Group', width: 16, value: (e) => tr(e.GroupName ?? '') });
    if (hasTasks) extras.push({ header: 'Task', width: 16, value: (e) => tr(e.TaskName ?? '') });
    if (withTemplate) extras.push({ header: 'Template', width: 24, value: () => tr(wb.Label || wb.Title) });
    if (hasRules) extras.push({ header: 'RulesAcknowledged', width: 22, value: (e) => (e.RulesAcknowledgedAt ? new Date(e.RulesAcknowledgedAt).toISOString() : '') });
    // Timing: when the participant pressed Start, when the table was handed in, how many minutes that took, and (with a countdown) whether
    // the time ran out. Every one of them is empty for a participant who has not started / not handed in.
    const iso = (v) => (v ? new Date(v).toISOString() : '');
    extras.push({ header: 'StartedAt', width: 22, value: (e) => iso(e.RulesAcknowledgedAt) });
    extras.push({ header: 'SubmittedAt', width: 22, value: (e) => (e.Status === 'SUBMITTED' ? iso(e.SubmittedAt) : '') });
    extras.push({ header: 'DurationMin', width: 14, value: (e) => (e.Status === 'SUBMITTED' && e.RulesAcknowledgedAt && e.SubmittedAt ? Math.max(0, Math.round((new Date(e.SubmittedAt).getTime() - new Date(e.RulesAcknowledgedAt).getTime()) / 60_000)) : '') });
    if (hasTimer) extras.push({ header: 'TimedOut', width: 12, value: (e) => (e.Status === 'SUBMITTED' ? (e.IsTimedOut ? 'Yes' : 'No') : '') });
    const extraCol = (i) => cols + 3 + i;

    // header rows: ParticipantId (merged down), template header cells, Status and the extra columns (merged down)
    for (let r = 0; r < rules.headerRows; r++) {
      for (let c = 0; c < cols; c++) {
        const text = tr(cellText(snap.cellData?.[r]?.[c]));
        if (text) ws.getCell(r + 1, c + 2).value = text;
      }
    }
    ws.getCell(1, 1).value = 'ParticipantId';
    ws.getCell(1, statusCol).value = 'Status';
    extras.forEach((x, i) => { ws.getCell(1, extraCol(i)).value = x.header; });
    if (rules.headerRows > 1) {
      ws.mergeCells(1, 1, rules.headerRows, 1);
      ws.mergeCells(1, statusCol, rules.headerRows, statusCol);
      extras.forEach((_, i) => ws.mergeCells(1, extraCol(i), rules.headerRows, extraCol(i)));
    }
    for (const m of snap.mergeData ?? []) {
      if (m.endRow < rules.headerRows && (m.endRow > m.startRow || m.endColumn > m.startColumn)) {
        ws.mergeCells(m.startRow + 1, m.startColumn + 2, m.endRow + 1, m.endColumn + 2);
      }
    }
    for (let r = 1; r <= rules.headerRows; r++) {
      ws.getRow(r).font = { bold: true };
      ws.getRow(r).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      ws.getRow(r).eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDFE6E2' } }; });
    }
    for (let c = 0; c < cols; c++) ws.getColumn(c + 2).width = Math.max(12, Math.round((snap.columnData?.[c]?.w ?? 100) / 7));
    ws.getColumn(1).width = 16;
    ws.getColumn(statusCol).width = 12;
    extras.forEach((x, i) => { ws.getColumn(extraCol(i)).width = x.width; });
    ws.views = [{ state: 'frozen', ySplit: rules.headerRows }];

    let rowNo = rules.headerRows + 1;
    for (const e of entries) {
      const rows = e.Rows?.[id] ?? {};
      for (const r of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
        ws.getCell(rowNo, 1).value = e.ParticipantId;
        for (const [c, v] of Object.entries(rows[r])) ws.getCell(rowNo, Number(c) + 2).value = typeof v === 'string' ? tr(v) : v;
        ws.getCell(rowNo, statusCol).value = e.Status;
        extras.forEach((x, i) => { ws.getCell(rowNo, extraCol(i)).value = x.value(e); });
        rowNo++;
      }
    }
  }
}

// ZIP: one folder per group, in it one Excel file per template that group's participants filled in. "groupId=all" (default) is every
// group (+ a folder for participants without one), a number is a single group. A research with no groups gets the files side by side.
const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'x';
const ZIP_LANGS = ['sr', 'en'];
const TRANSLATION_STATUS = { TRANSLATION_NOT_CONFIGURED: 503, TRANSLATION_TIMEOUT: 504, TRANSLATION_FAILED: 502, TRANSLATION_TOO_LARGE: 413 };

router.get('/:researchId/export-zip', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const raw = req.query.groupId;
    const only = raw == null || raw === '' || raw === 'all' ? null : Number(raw);
    if (only != null && (!Number.isInteger(only) || only <= 0)) { res.status(400).json({ error: 'Invalid groupId' }); return; }
    // lang=en: the whole file is translated from Serbian to English (see server/translate/translator.mjs); sr (default) is the original
    const lang = req.query.lang == null || req.query.lang === '' ? 'sr' : String(req.query.lang);
    if (!ZIP_LANGS.includes(lang)) { res.status(400).json({ error: 'Invalid lang' }); return; }
    if (lang === 'en' && !translationConfigured()) { res.status(503).json({ error: 'TRANSLATION_NOT_CONFIGURED' }); return; }
    const english = lang === 'en';
    const slots = await loadWorkbookSlots(sql, researchId);
    if (!slots.length) { res.status(404).json({ error: 'NO_WORKBOOK' }); return; }
    const groups = await sql`SELECT "Id","Name" FROM "ResearchGroup" WHERE "ResearchId" = ${researchId} ORDER BY "Id"`;
    if (only != null && !groups.some((g) => g.Id === only)) { res.status(404).json({ error: 'NO_GROUP' }); return; }
    const hasGroups = groups.length > 0;
    const hasTasks = (await sql`SELECT 1 FROM "ResearchTask" WHERE "ResearchId" = ${researchId} LIMIT 1`).length > 0;
    const hasCodes = (await sql`SELECT 1 FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantCode" IS NOT NULL LIMIT 1`).length > 0;
    const hasTimer = !!(await loadResearch(sql, researchId))?.SheetsTimerMinutes;
    // what to build: a research with groups gets a folder per group (and one for people without a group when all are wanted)
    const targets = !hasGroups ? [{ kind: 'any', gid: null, folder: '', noGroup: false }]
      : [...groups.filter((g) => only == null || g.Id === only).map((g) => ({ kind: 'group', gid: g.Id, folder: g.Name, noGroup: false })),
         ...(only == null ? [{ kind: 'none', gid: null, folder: '', noGroup: true }] : [])];

    // phase 1: read what goes into every file (no empty files)
    const plan = [];
    for (const t of targets) {
      for (const slot of slots) {
        const wb = await loadWorkbookById(sql, researchId, slot.Id);
        const entries = await sql`
          SELECT p."ParticipantId", p."ParticipantCode", g."Name" AS "GroupName", tk."Name" AS "TaskName", l."RulesAcknowledgedAt", e."Rows", e."Status", e."SubmittedAt", e."IsTimedOut"
          FROM "SheetEntry" e JOIN "Participant" p ON p."Guid" = e."ParticipantGuid"
          LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
          LEFT JOIN "ResearchTask" tk ON tk."Id" = p."ResearchTaskId"
          LEFT JOIN "SheetAccessLink" l ON l."ParticipantGuid" = e."ParticipantGuid" AND l."WorkbookId" = e."WorkbookId"
          WHERE e."WorkbookId" = ${wb.Id} AND p."ResearchId" = ${researchId}
            AND (${t.kind} = 'any' OR (${t.kind} = 'none' AND p."GroupId" IS NULL) OR (${t.kind} = 'group' AND p."GroupId" = ${t.gid}::int))
          ORDER BY p."ParticipantId"
        `;
        if (entries.length) plan.push({ t, wb, entries });
      }
    }
    if (!plan.length) { res.status(404).json({ error: 'NO_ENTRIES' }); return; }

    // phase 2: build the files. With lang=en a dry run first collects every text, they are translated together (cached per research),
    // then the real files are built with the translations.
    const flags = { hasCodes, hasGroups, hasTasks, hasTimer, prefix: '', withTemplate: false };
    const build = (tr, write) => {
      const files = [];
      const used = new Set();
      for (const { t, wb, entries } of plan) {
        const book = new ExcelJS.Workbook();
        addWorkbookSheets(book, wb, entries, { ...flags, tr }, new Set());
        const folder = t.noGroup ? (english ? 'no-group' : 'bez-grupe') : tr(t.folder);
        const base = safeName(tr(wb.Label || wb.Title || `${english ? 'template' : 'sablon'}-${wb.Id}`));
        const dir = folder ? safeName(folder) : '';
        let path = dir ? `${dir}/${base}.xlsx` : `${base}.xlsx`;
        for (let n = 2; used.has(path.toLowerCase()); n++) path = dir ? `${dir}/${base} (${n}).xlsx` : `${base} (${n}).xlsx`;
        used.add(path.toLowerCase());
        files.push({ path, book: write ? book : null });
      }
      return files;
    };
    let tr = same;
    if (english) {
      const seen = new Set();
      build((s) => { if (typeof s === 'string' && needsTranslation(s)) seen.add(s); return s; }, false);
      for (const g of groups) if (only == null || g.Id === only) seen.add(g.Name);
      const map = await translateTexts(sql, researchId, [...seen]);
      tr = (s) => (typeof s === 'string' ? (map.get(s) ?? s) : s);
    }
    const files = build(tr, true);
    const groupName = only != null ? groups.find((g) => g.Id === only).Name : null;
    const label = only != null ? safeName(tr(groupName)).replace(/ /g, '-') : (english ? 'all-groups' : 'sve-grupe');
    const buffers = [];
    for (const f of files) buffers.push({ path: f.path, buffer: Buffer.from(await f.book.xlsx.writeBuffer()) });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${english ? 'tables' : 'tabele'}-${label}.zip"`);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('[sheets] zip stream error:', err); res.destroy(err); });
    archive.pipe(res);
    for (const f of buffers) archive.append(f.buffer, { name: f.path });
    await archive.finalize();
  } catch (err) {
    if (err instanceof TranslationError) {
      console.error('[sheets] zip translation:', err.message);
      if (!res.headersSent) res.status(TRANSLATION_STATUS[err.code] ?? 502).json({ error: err.code });
      return;
    }
    console.error('[sheets] zip export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/export', async (req, res) => {
  const researchId = parseId(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const only = req.query.workbookId != null ? Number(req.query.workbookId) : null;
    if (only != null && (!Number.isInteger(only) || only <= 0)) { res.status(400).json({ error: 'Invalid workbookId' }); return; }
    const slots = await loadWorkbookSlots(sql, researchId);
    const chosen = only != null ? slots.filter((w) => w.Id === only) : slots;
    if (!chosen.length) { res.status(404).json({ error: 'NO_WORKBOOK' }); return; }
    // A trailing Group / Task column only for a research that defines them, so every other export keeps its shape.
    const hasGroups = (await sql`SELECT 1 FROM "ResearchGroup" WHERE "ResearchId" = ${researchId} LIMIT 1`).length > 0;
    const hasTasks = (await sql`SELECT 1 FROM "ResearchTask" WHERE "ResearchId" = ${researchId} LIMIT 1`).length > 0;
    const hasCodes = (await sql`SELECT 1 FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantCode" IS NOT NULL LIMIT 1`).length > 0;
    const hasTimer = !!(await loadResearch(sql, researchId))?.SheetsTimerMinutes;
    const book = new ExcelJS.Workbook();
    const usedNames = new Set();
    const several = chosen.length > 1;
    for (const slot of chosen) {
      const wb = await loadWorkbookById(sql, researchId, slot.Id);
      const entries = await sql`
        SELECT p."ParticipantId", p."ParticipantCode", g."Name" AS "GroupName", t."Name" AS "TaskName", l."RulesAcknowledgedAt", e."Rows", e."Status", e."SubmittedAt", e."IsTimedOut"
        FROM "SheetEntry" e JOIN "Participant" p ON p."Guid" = e."ParticipantGuid"
        LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
        LEFT JOIN "ResearchTask" t ON t."Id" = p."ResearchTaskId"
        LEFT JOIN "SheetAccessLink" l ON l."ParticipantGuid" = e."ParticipantGuid" AND l."WorkbookId" = e."WorkbookId"
        WHERE e."WorkbookId" = ${wb.Id} AND p."ResearchId" = ${researchId}
        ORDER BY p."ParticipantId"
      `;
      addWorkbookSheets(book, wb, entries, { hasCodes, hasGroups, hasTasks, hasTimer, prefix: several ? (wb.Label || wb.Title || `T${wb.Id}`) : '', withTemplate: several }, usedNames);
    }
    const buffer = await book.xlsx.writeBuffer();
    const fileLabel = only != null ? String(chosen[0].Label || chosen[0].Title || only).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sheets-research-${researchId}${only != null ? '-' + fileLabel : ''}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[sheets] export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
