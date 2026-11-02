// Which sheet template a participant gets (2026-10-30). A research has one template per (group, task) slot; a slot with a
// NULL group and/or task means "any". The most specific template that fits wins, so a research with a single default
// template (the only kind there was before) keeps working unchanged.

/** The templates of a research, with the slot each is for. */
export async function loadWorkbookSlots(sql, researchId) {
  return sql`
    SELECT "Id","Label","Title","GroupId","ResearchTaskId"
    FROM "SheetWorkbook" WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder","Id"
  `;
}

/** Picks the template for a group and a task out of a research's templates, or null when none fits. */
export function pickWorkbook(workbooks, groupId, taskId) {
  const g = groupId ?? null;
  const t = taskId ?? null;
  const order = [[g, t], [g, null], [null, t], [null, null]];
  for (const [wantGroup, wantTask] of order) {
    const hit = workbooks.find((w) => (w.GroupId ?? null) === wantGroup && (w.ResearchTaskId ?? null) === wantTask);
    if (hit) return hit;
  }
  return null;
}

/** The template for one participant (loads their research, group and task). Null when none fits. */
export async function resolveSheetWorkbook(sql, participantGuid) {
  const rows = await sql`SELECT "ResearchId","GroupId","ResearchTaskId" FROM "Participant" WHERE "Guid" = ${participantGuid} LIMIT 1`;
  if (!rows.length) return null;
  const workbooks = await loadWorkbookSlots(sql, rows[0].ResearchId);
  return pickWorkbook(workbooks, rows[0].GroupId, rows[0].ResearchTaskId);
}

/**
 * Stores a participant's link to a template: a new token replaces the old one but keeps the rules acknowledgement. A link
 * to another template of this research that nobody has started (left over when the participant's group or task changed)
 * is removed, so it cannot keep working next to the right one.
 */
export async function upsertSheetLink(sql, { token, workbookId, participantGuid, expiresAt }) {
  await sql`
    INSERT INTO "SheetAccessLink" ("Token","WorkbookId","ParticipantGuid","ExpiresAt")
    VALUES (${token}, ${workbookId}, ${participantGuid}, ${expiresAt.toISOString()})
    ON CONFLICT ("WorkbookId","ParticipantGuid") DO UPDATE
      SET "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
  `;
  await sql`
    DELETE FROM "SheetAccessLink" l
    WHERE l."ParticipantGuid" = ${participantGuid} AND l."WorkbookId" <> ${workbookId}
      AND l."WorkbookId" IN (SELECT "Id" FROM "SheetWorkbook" WHERE "ResearchId" = (SELECT "ResearchId" FROM "SheetWorkbook" WHERE "Id" = ${workbookId}))
      AND NOT EXISTS (SELECT 1 FROM "SheetEntry" e WHERE e."WorkbookId" = l."WorkbookId" AND e."ParticipantGuid" = l."ParticipantGuid")
  `;
}

// ── availability window (2026-10-30) ────────────────────────────────────────────────────────────────

/** When the research's tables open and close (Date or null each). Enforced by the sheets app on every link request. */
export async function loadSheetsWindow(sql, researchId) {
  const rows = await sql`SELECT "SheetsOpensAt","SheetsClosesAt" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
  const r = rows[0];
  return {
    opensAt: r?.SheetsOpensAt ? new Date(r.SheetsOpensAt) : null,
    closesAt: r?.SheetsClosesAt ? new Date(r.SheetsClosesAt) : null,
  };
}

/** A link must not expire before the table closes: the later of "now + the usual lifetime" and the closing time. */
export function sheetLinkExpiry(window, ttlMs) {
  const usual = Date.now() + ttlMs;
  return new Date(window.closesAt ? Math.max(usual, window.closesAt.getTime()) : usual);
}
