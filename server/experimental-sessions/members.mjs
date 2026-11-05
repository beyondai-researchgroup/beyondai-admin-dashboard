// Who belongs to an experimental session. A session is a day (and optionally a group). Its participants are, from three sources:
//   WORK      people who started a task that day (Sheets: pressed Start; Generic task: opened it), within the session's group if it has one
//   SLOT      attendees of a termin of this session (PROTOCOL researches)
//   ASSIGNED  participant-sessions assigned to it (classic researches)
// The task work is read from what the participants actually did, so nobody has to be added by hand.

const TZ = 'Europe/Belgrade';

/** The calendar day (YYYY-MM-DD) a moment falls on, in the researchers' time zone. */
export function belgradeDay(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** The session's own day as YYYY-MM-DD (the neon driver parses a DATE with local getters, see experimental-sessions/routes.mjs). */
export function sessionDay(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every task start of a research: one row per participant x task kind. Filtered by day / group per session in JS. */
export async function loadWorkEvents(sql, researchId) {
  const sheets = await sql`
    SELECT p."Guid", p."ParticipantId", p."ParticipantCode", p."GroupId", g."Name" AS "GroupName", t."Name" AS "TaskName",
           MAX(l."RulesAcknowledgedAt") AS "StartedAt", MAX(e."SubmittedAt") FILTER (WHERE e."Status" = 'SUBMITTED') AS "SubmittedAt",
           COALESCE(bool_or(e."Status" = 'SUBMITTED'), FALSE) AS "Submitted", COALESCE(bool_or(e."IsTimedOut"), FALSE) AS "TimedOut"
    FROM "SheetAccessLink" l
    JOIN "SheetWorkbook" w ON w."Id" = l."WorkbookId"
    JOIN "Participant" p ON p."Guid" = l."ParticipantGuid"
    LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    LEFT JOIN "ResearchTask" t ON t."Id" = p."ResearchTaskId"
    LEFT JOIN "SheetEntry" e ON e."WorkbookId" = l."WorkbookId" AND e."ParticipantGuid" = l."ParticipantGuid"
    WHERE w."ResearchId" = ${researchId} AND l."RulesAcknowledgedAt" IS NOT NULL
    GROUP BY p."Guid", p."ParticipantId", p."ParticipantCode", p."GroupId", g."Name", t."Name"
  `;
  // a database that has not had migration 049 yet simply has no generic-task starts
  const generic = await sql`
    SELECT p."Guid", p."ParticipantId", p."ParticipantCode", p."GroupId", g."Name" AS "GroupName", gt."Title" AS "TaskName",
           st."StartedAt", sub."SubmittedAt", (sub."ParticipantGuid" IS NOT NULL) AS "Submitted", COALESCE(sub."IsTimedOut", FALSE) AS "TimedOut"
    FROM "GenericTaskStart" st
    JOIN "Participant" p ON p."Guid" = st."ParticipantGuid"
    LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    LEFT JOIN "GenericTask" gt ON gt."Id" = p."GenericTaskId"
    LEFT JOIN "GenericTaskSubmission" sub ON sub."ParticipantGuid" = p."Guid"
    WHERE p."ResearchId" = ${researchId}
  `.catch((err) => { if (err?.code === '42P01') return []; throw err; });
  const map = (rows, kind) => rows.map((r) => ({
    guid: r.Guid, participantId: r.ParticipantId, code: r.ParticipantCode ?? null, groupId: r.GroupId ?? null, groupName: r.GroupName ?? null, taskName: r.TaskName ?? null,
    kind, startedAt: r.StartedAt, submittedAt: r.Submitted ? (r.SubmittedAt ?? null) : null,
    status: r.Submitted ? (r.TimedOut ? 'TIMED_OUT' : 'SUBMITTED') : 'WORKING',
    durationMin: r.Submitted && r.SubmittedAt && r.StartedAt ? Math.max(0, Math.round((new Date(r.SubmittedAt).getTime() - new Date(r.StartedAt).getTime()) / 60_000)) : null,
  }));
  return [...map(sheets, 'SHEETS'), ...map(generic, 'GENERIC_TASK')];
}

/**
 * The group whose participants a session shows: the one chosen on it, else the group whose name the session is called
 * (sessions are often named after the group they were held for). `fromLabel` tells the second case apart.
 */
export function effectiveGroup(session, groups) {
  if (session.GroupId != null) return { id: session.GroupId, fromLabel: false };
  const label = String(session.Label ?? '').trim().toLowerCase();
  const hit = label ? groups.find((g) => String(g.Name).trim().toLowerCase() === label) : null;
  return hit ? { id: hit.Id, fromLabel: true } : { id: null, fromLabel: false };
}

/** The work events of one session: that day, and that group when there is one. */
export function workForSession(session, events, groups) {
  const day = sessionDay(session.SessionDate);
  const group = effectiveGroup(session, groups);
  return events
    .filter((e) => belgradeDay(e.startedAt) === day && (group.id == null || e.groupId === group.id))
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

/** Every participant of a session (union of the three sources), keyed by participant guid. */
export async function loadMembers(sql, session, events, groups) {
  const members = new Map();
  const add = (guid, participantId, code, groupName, source) => {
    const m = members.get(guid) ?? { guid, participantId, code: code ?? null, groupName: groupName ?? null, sources: [] };
    if (!m.sources.includes(source)) m.sources.push(source);
    members.set(guid, m);
  };
  for (const e of workForSession(session, events, groups)) add(e.guid, e.participantId, e.code, e.groupName, 'WORK');
  const slots = await sql`
    SELECT p."Guid", p."ParticipantId", p."ParticipantCode", g."Name" AS "GroupName"
    FROM "SessionSlot" s JOIN "SessionSlotAttendee" a ON a."SlotId" = s."Id"
    JOIN "Participant" p ON p."Guid" = a."ParticipantGuid" LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    WHERE s."ExperimentalSessionId" = ${session.Id}
  `;
  for (const r of slots) add(r.Guid, r.ParticipantId, r.ParticipantCode, r.GroupName, 'SLOT');
  const assigned = await sql`
    SELECT DISTINCT p."Guid", p."ParticipantId", p."ParticipantCode", g."Name" AS "GroupName"
    FROM "ParticipantSession" ps JOIN "Participant" p ON p."ParticipantId" = ps."ParticipantId" AND p."ResearchId" = ${session.ResearchId}
    LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    WHERE ps."ExperimentalSessionId" = ${session.Id}
  `;
  for (const r of assigned) add(r.Guid, r.ParticipantId, r.ParticipantCode, r.GroupName, 'ASSIGNED');
  return members;
}
