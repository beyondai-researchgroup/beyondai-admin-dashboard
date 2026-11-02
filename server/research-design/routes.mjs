import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { planAssignment, applyAssignment, summarize, loadGroups, loadTasks } from './assign.mjs';

// Research design (2026-10): what kind of study this is, its variables and its participant groups.
// Only researches created with FlowMode='PROTOCOL' have one; every CLASSIC research (the original
// BeyondAI flow, incl. the study in progress) is rejected here with NOT_PROTOCOL, so this router can
// never touch it. Every design field is optional ("not specified").
const router = Router();
router.use(requireAuth);

const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];

// Allowed values (mirrored by the CHECK constraints in Sql/035_research_design.sql and by the frontend).
export const DESIGN_FIELDS = {
  approach: ['EXPERIMENTAL', 'QUASI_EXPERIMENTAL', 'CORRELATIONAL', 'DESCRIPTIVE'],
  subjectDesign: ['BETWEEN', 'WITHIN', 'MIXED', 'SINGLE_GROUP'],
  timeDimension: ['CROSS_SECTIONAL', 'PRE_POST', 'REPEATED', 'CROSSOVER'],
  factorStructure: ['SINGLE_FACTOR', 'FACTORIAL'],
  controlCondition: ['NONE', 'NO_TREATMENT', 'PLACEBO_ACTIVE', 'WAITLIST', 'TREATMENT_AS_USUAL'],
  blinding: ['NONE', 'SINGLE', 'DOUBLE'],
};
const DESIGN_COLUMNS = {
  approach: 'Approach',
  subjectDesign: 'SubjectDesign',
  timeDimension: 'TimeDimension',
  factorStructure: 'FactorStructure',
  controlCondition: 'ControlCondition',
  blinding: 'Blinding',
};
const ASSIGNMENT_MODES = ['MANUAL', 'RANDOM'];
const VARIABLE_ROLES = ['INDEPENDENT', 'DEPENDENT', 'CONTROL', 'MODERATOR', 'MEDIATOR', 'COVARIATE'];
const MAX_VARIABLES = 30;
const MAX_GROUPS = 12;
const MAX_TASKS = 8;
const MAX_LEVELS = 20;
const MAX_LEVEL_LENGTH = 100;
const MAX_NAME = 200;
const MAX_GROUP_NAME = 100;
const MAX_TASK_NAME = 100;
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 1000;
const MAX_RANDOMIZE = 2000; // manual bulk assignment (the random run has its own cap in assign.mjs)

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

const isOptionalText = (v, max) => v == null || v === '' || (typeof v === 'string' && v.length <= max);
const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Validates the research id from the URL and the scope; answers the request itself on failure. */
function parseResearchId(req, res) {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return null;
  }
  if (!scopeGuard(req, res, researchId)) return null;
  return researchId;
}

/** Loads the research and refuses a CLASSIC one. Returns the row, or null after answering. */
async function requireProtocolResearch(sql, res, researchId) {
  const rows = await sql`SELECT "Id","FlowMode","SetupComplete" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
  if (!rows[0]) {
    res.status(404).json({ error: 'Research not found' });
    return null;
  }
  if (rows[0].FlowMode !== 'PROTOCOL') {
    res.status(400).json({ error: 'NOT_PROTOCOL' });
    return null;
  }
  return rows[0];
}

function requireWrite(req, res, researchId) {
  if (!hasMinRole(req.researcher, researchId, WRITE_ROLES)) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return false;
  }
  return true;
}

async function loadDocument(sql, researchId, setupComplete) {
  const [designRows, variables, groups, tasks] = await Promise.all([
    sql`SELECT * FROM "ResearchDesign" WHERE "ResearchId" = ${researchId} LIMIT 1`,
    sql`SELECT "Id","SortOrder","Role","Name","Description","Levels","Measurement" FROM "ResearchVariable" WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder","Id"`,
    sql`
      SELECT g."Id", g."Name", g."Description", g."Weight", g."IsControl",
             (SELECT COUNT(*)::int FROM "Participant" p WHERE p."GroupId" = g."Id") AS "ParticipantCount"
      FROM "ResearchGroup" g WHERE g."ResearchId" = ${researchId} ORDER BY g."SortOrder", g."Id"
    `,
    sql`
      SELECT t."Id", t."Name", t."Weight", t."PdfFilename", t."PdfSize",
             (SELECT COUNT(*)::int FROM "Participant" p WHERE p."ResearchTaskId" = t."Id") AS "ParticipantCount"
      FROM "ResearchTask" t WHERE t."ResearchId" = ${researchId} ORDER BY t."SortOrder", t."Id"
    `,
  ]);
  const counts = await sql`
    SELECT COUNT(*)::int AS "Total", COUNT(*) FILTER (WHERE "GroupId" IS NULL)::int AS "Unassigned",
           COUNT(*) FILTER (WHERE "ResearchTaskId" IS NULL)::int AS "UnassignedTask"
    FROM "Participant" WHERE "ResearchId" = ${researchId}
  `;
  const d = designRows[0] ?? {};
  return {
    setupComplete: setupComplete !== false,
    design: {
      approach: d.Approach ?? null,
      subjectDesign: d.SubjectDesign ?? null,
      timeDimension: d.TimeDimension ?? null,
      factorStructure: d.FactorStructure ?? null,
      controlCondition: d.ControlCondition ?? null,
      blinding: d.Blinding ?? null,
      assignmentMode: d.AssignmentMode ?? 'MANUAL',
      hypotheses: d.Hypotheses ?? null,
      notes: d.Notes ?? null,
    },
    variables: variables.map((v) => ({
      id: v.Id,
      role: v.Role,
      name: v.Name,
      description: v.Description,
      levels: Array.isArray(v.Levels) ? v.Levels : [],
      measurement: v.Measurement,
    })),
    groups: groups.map((g) => ({
      id: g.Id,
      name: g.Name,
      description: g.Description,
      weight: g.Weight,
      isControl: g.IsControl,
      participantCount: g.ParticipantCount,
    })),
    tasks: tasks.map((t) => ({ id: t.Id, name: t.Name, weight: t.Weight, participantCount: t.ParticipantCount, hasPdf: !!t.PdfFilename, pdfName: t.PdfFilename ?? null, pdfSize: t.PdfSize ?? null })),
    participantCount: counts[0]?.Total ?? 0,
    unassignedCount: counts[0]?.Unassigned ?? 0,
    unassignedTaskCount: counts[0]?.UnassignedTask ?? 0,
  };
}

router.get('/:researchId', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    res.json(await loadDocument(sql, researchId, research.SetupComplete));
  } catch (err) {
    console.error('[research-design] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/** Validates the whole incoming document; returns { design, variables, groups } or { error }. */
function normalizeDocument(body) {
  const { design, variables, groups, tasks } = body ?? {};
  if (!design || typeof design !== 'object') return { error: 'design is required' };
  const d = {};
  for (const [field, allowed] of Object.entries(DESIGN_FIELDS)) {
    const v = design[field];
    if (v == null || v === '') {
      d[field] = null;
    } else if (typeof v === 'string' && allowed.includes(v)) {
      d[field] = v;
    } else {
      return { error: `Invalid design.${field}` };
    }
  }
  const mode = design.assignmentMode ?? 'MANUAL';
  if (!ASSIGNMENT_MODES.includes(mode)) return { error: 'Invalid design.assignmentMode' };
  d.assignmentMode = mode;
  if (!isOptionalText(design.hypotheses, MAX_TEXT) || !isOptionalText(design.notes, MAX_TEXT)) {
    return { error: `hypotheses and notes are up to ${MAX_TEXT} characters` };
  }
  d.hypotheses = cleanText(design.hypotheses);
  d.notes = cleanText(design.notes);

  if (!Array.isArray(variables) || variables.length > MAX_VARIABLES) {
    return { error: `variables must be an array (up to ${MAX_VARIABLES} entries)` };
  }
  const vars = [];
  for (const raw of variables) {
    if (!raw || typeof raw !== 'object') return { error: 'Invalid variable' };
    if (!VARIABLE_ROLES.includes(raw.role)) return { error: 'Each variable needs a valid role' };
    const name = cleanText(raw.name);
    if (!name || name.length > MAX_NAME) return { error: `Each variable needs a name (up to ${MAX_NAME} characters)` };
    if (!isOptionalText(raw.description, MAX_TEXT) || !isOptionalText(raw.measurement, MAX_SHORT_TEXT)) {
      return { error: 'A variable description or measurement is too long' };
    }
    let levels = [];
    if (raw.levels != null) {
      if (!Array.isArray(raw.levels) || raw.levels.length > MAX_LEVELS) return { error: `levels is an array of up to ${MAX_LEVELS} entries` };
      levels = raw.levels.map((l) => (typeof l === 'string' ? l.trim() : '')).filter(Boolean);
      if (levels.some((l) => l.length > MAX_LEVEL_LENGTH)) return { error: `A level is up to ${MAX_LEVEL_LENGTH} characters` };
    }
    vars.push({
      role: raw.role,
      name,
      description: cleanText(raw.description),
      levels,
      measurement: cleanText(raw.measurement),
    });
  }

  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
    return { error: `groups must be an array (up to ${MAX_GROUPS} entries)` };
  }
  const grps = [];
  const seenNames = new Set();
  for (const raw of groups) {
    if (!raw || typeof raw !== 'object') return { error: 'Invalid group' };
    const name = cleanText(raw.name);
    if (!name || name.length > MAX_GROUP_NAME) return { error: `Each group needs a name (up to ${MAX_GROUP_NAME} characters)` };
    const key = name.toLowerCase();
    if (seenNames.has(key)) return { error: 'DUPLICATE_GROUP_NAME', name };
    seenNames.add(key);
    if (!isOptionalText(raw.description, MAX_SHORT_TEXT)) return { error: 'A group description is too long' };
    const weight = raw.weight == null ? 1 : Number(raw.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { error: 'A group weight is an integer from 1 to 100' };
    if (raw.id != null && !Number.isInteger(Number(raw.id))) return { error: 'Invalid group id' };
    grps.push({
      id: raw.id != null ? Number(raw.id) : null,
      name,
      description: cleanText(raw.description),
      weight,
      isControl: raw.isControl === true,
    });
  }

  let tsks;
  if (tasks !== undefined) {
    if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) return { error: `tasks must be an array (up to ${MAX_TASKS} entries)` };
    tsks = [];
    const seenTasks = new Set();
    for (const raw of tasks) {
      if (!raw || typeof raw !== 'object') return { error: 'Invalid task' };
      const name = cleanText(raw.name);
      if (!name || name.length > MAX_TASK_NAME) return { error: `Each task needs a name (up to ${MAX_TASK_NAME} characters)` };
      const key = name.toLowerCase();
      if (seenTasks.has(key)) return { error: 'DUPLICATE_TASK_NAME', name };
      seenTasks.add(key);
      const weight = raw.weight == null ? 1 : Number(raw.weight);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { error: 'A task weight is an integer from 1 to 100' };
      if (raw.id != null && !Number.isInteger(Number(raw.id))) return { error: 'Invalid task id' };
      tsks.push({ id: raw.id != null ? Number(raw.id) : null, name, weight });
    }
  }
  return { design: d, variables: vars, groups: grps, tasks: tsks };
}

// Replaces the design document. Variables are replaced wholesale (nothing references them). Groups are
// an upsert by id, because participants reference them: a group with an id is UPDATEd in place, one
// without an id is INSERTed, an existing one missing from the payload is DELETEd (refused while any
// participant is in it).
router.put('/:researchId', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const doc = normalizeDocument(req.body);
  if (doc.error) {
    res.status(400).json({ error: doc.error, ...(doc.name ? { name: doc.name } : {}) });
    return;
  }
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;

    const existing = await sql`
      SELECT g."Id", (SELECT COUNT(*)::int FROM "Participant" p WHERE p."GroupId" = g."Id") AS "N",
             (SELECT COUNT(*)::int FROM "SessionSlot" sl WHERE sl."GroupId" = g."Id") AS "Slots"
      FROM "ResearchGroup" g WHERE g."ResearchId" = ${researchId}
    `;
    const existingIds = new Set(existing.map((g) => g.Id));
    const keptIds = doc.groups.filter((g) => g.id != null).map((g) => g.id);
    if (keptIds.some((id) => !existingIds.has(id))) {
      res.status(400).json({ error: 'Unknown group id for this research' });
      return;
    }
    if (new Set(keptIds).size !== keptIds.length) {
      res.status(400).json({ error: 'Duplicate group id in payload' });
      return;
    }
    for (const e of existing) {
      if (!keptIds.includes(e.Id) && e.N > 0) {
        res.status(409).json({ error: 'GROUP_HAS_PARTICIPANTS', groupId: e.Id });
        return;
      }
      if (!keptIds.includes(e.Id) && e.Slots > 0) {
        res.status(409).json({ error: 'GROUP_HAS_SESSIONS', groupId: e.Id });
        return;
      }
    }

    let existingTasks = [];
    let keptTaskIds = [];
    if (doc.tasks) {
      existingTasks = await sql`
        SELECT t."Id", (SELECT COUNT(*)::int FROM "Participant" p WHERE p."ResearchTaskId" = t."Id") AS "N"
        FROM "ResearchTask" t WHERE t."ResearchId" = ${researchId}
      `;
      const knownTaskIds = new Set(existingTasks.map((t) => t.Id));
      keptTaskIds = doc.tasks.filter((t) => t.id != null).map((t) => t.id);
      if (keptTaskIds.some((id) => !knownTaskIds.has(id))) {
        res.status(400).json({ error: 'Unknown task id for this research' });
        return;
      }
      if (new Set(keptTaskIds).size !== keptTaskIds.length) {
        res.status(400).json({ error: 'Duplicate task id in payload' });
        return;
      }
      for (const e of existingTasks) {
        if (!keptTaskIds.includes(e.Id) && e.N > 0) {
          res.status(409).json({ error: 'TASK_HAS_PARTICIPANTS', taskId: e.Id });
          return;
        }
      }
    }

    const d = doc.design;
    await sql`
      INSERT INTO "ResearchDesign"
        ("ResearchId","Approach","SubjectDesign","TimeDimension","FactorStructure","ControlCondition","Blinding","AssignmentMode","Hypotheses","Notes","UpdatedAt")
      VALUES (${researchId}, ${d.approach}, ${d.subjectDesign}, ${d.timeDimension}, ${d.factorStructure}, ${d.controlCondition},
              ${d.blinding}, ${d.assignmentMode}, ${d.hypotheses}, ${d.notes}, NOW())
      ON CONFLICT ("ResearchId") DO UPDATE SET
        "Approach" = EXCLUDED."Approach", "SubjectDesign" = EXCLUDED."SubjectDesign", "TimeDimension" = EXCLUDED."TimeDimension",
        "FactorStructure" = EXCLUDED."FactorStructure", "ControlCondition" = EXCLUDED."ControlCondition", "Blinding" = EXCLUDED."Blinding",
        "AssignmentMode" = EXCLUDED."AssignmentMode", "Hypotheses" = EXCLUDED."Hypotheses", "Notes" = EXCLUDED."Notes", "UpdatedAt" = NOW()
    `;

    await sql`DELETE FROM "ResearchVariable" WHERE "ResearchId" = ${researchId}`;
    for (let i = 0; i < doc.variables.length; i++) {
      const v = doc.variables[i];
      await sql`
        INSERT INTO "ResearchVariable" ("ResearchId","SortOrder","Role","Name","Description","Levels","Measurement")
        VALUES (${researchId}, ${i}, ${v.role}, ${v.name}, ${v.description}, ${JSON.stringify(v.levels)}::jsonb, ${v.measurement})
      `;
    }

    try {
      for (const e of existing) {
        if (!keptIds.includes(e.Id)) await sql`DELETE FROM "ResearchGroup" WHERE "Id" = ${e.Id}`;
      }
      if (doc.tasks) {
        for (const e of existingTasks) {
          if (!keptTaskIds.includes(e.Id)) await sql`DELETE FROM "ResearchTask" WHERE "Id" = ${e.Id}`;
        }
        for (let i = 0; i < doc.tasks.length; i++) {
          const t = doc.tasks[i];
          if (t.id != null) {
            await sql`UPDATE "ResearchTask" SET "SortOrder" = ${i}, "Name" = ${t.name}, "Weight" = ${t.weight} WHERE "Id" = ${t.id} AND "ResearchId" = ${researchId}`;
          } else {
            await sql`INSERT INTO "ResearchTask" ("ResearchId","SortOrder","Name","Weight") VALUES (${researchId}, ${i}, ${t.name}, ${t.weight})`;
          }
        }
      }
      for (let i = 0; i < doc.groups.length; i++) {
        const g = doc.groups[i];
        if (g.id != null) {
          await sql`
            UPDATE "ResearchGroup"
            SET "SortOrder" = ${i}, "Name" = ${g.name}, "Description" = ${g.description}, "Weight" = ${g.weight}, "IsControl" = ${g.isControl}
            WHERE "Id" = ${g.id} AND "ResearchId" = ${researchId}
          `;
        } else {
          await sql`
            INSERT INTO "ResearchGroup" ("ResearchId","SortOrder","Name","Description","Weight","IsControl")
            VALUES (${researchId}, ${i}, ${g.name}, ${g.description}, ${g.weight}, ${g.isControl})
          `;
        }
      }
    } catch (err) {
      // Two groups swapping names inside one save can transiently collide on the unique name index.
      if (err?.code === '23505') {
        res.status(409).json({ error: String(err.message).includes('ResearchTask') ? 'DUPLICATE_TASK_NAME' : 'DUPLICATE_GROUP_NAME' });
        return;
      }
      // A group or a task that a sheet template is built for cannot be deleted from under it.
      if (err?.code === '23503') {
        res.status(409).json({ error: String(err.message).includes('ResearchTask') ? 'TASK_HAS_TEMPLATES' : 'GROUP_HAS_TEMPLATES' });
        return;
      }
      throw err;
    }
    res.json(await loadDocument(sql, researchId, research.SetupComplete));
  } catch (err) {
    console.error('[research-design] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Marks the study wizard as finished. A research created through the wizard stays "not set up yet"
// (listed with a "continue setup" action) until this is called.
router.post('/:researchId/complete-setup', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    await sql`UPDATE "Research" SET "SetupComplete" = TRUE WHERE "Id" = ${researchId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[research-design] complete-setup error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Group assignment ────────────────────────────────────────────────────────

/** Participants of this research, by public ParticipantId, with whether the protocol has started for them. */
async function loadParticipants(sql, researchId, participantIds) {
  const rows = participantIds
    ? await sql`
        SELECT p."Guid", p."ParticipantId", p."GroupId",
               EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid") AS "Started"
        FROM "Participant" p WHERE p."ResearchId" = ${researchId} AND p."ParticipantId" = ANY(${participantIds})
      `
    : await sql`
        SELECT p."Guid", p."ParticipantId", p."GroupId",
               EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid") AS "Started"
        FROM "Participant" p WHERE p."ResearchId" = ${researchId}
      `;
  return rows;
}


// Manual assignment of one or many participants. groupId null clears the group. Locked once the
// participant's protocol has started (a participant must not change condition mid-study).
router.put('/:researchId/group-assignments', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const { assignments } = req.body ?? {};
  if (!Array.isArray(assignments) || !assignments.length || assignments.length > MAX_RANDOMIZE) {
    res.status(400).json({ error: `assignments must be a non-empty array (up to ${MAX_RANDOMIZE} entries)` });
    return;
  }
  for (const a of assignments) {
    if (!a || typeof a.participantId !== 'string' || !a.participantId) {
      res.status(400).json({ error: 'Each assignment needs a participantId' });
      return;
    }
    if (a.groupId != null && !Number.isInteger(Number(a.groupId))) {
      res.status(400).json({ error: 'Invalid groupId' });
      return;
    }
  }
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    const groups = await loadGroups(sql, researchId);
    const groupIds = new Set(groups.map((g) => g.Id));
    const people = await loadParticipants(sql, researchId, assignments.map((a) => a.participantId));
    const byId = new Map(people.map((p) => [p.ParticipantId, p]));
    for (const a of assignments) {
      const p = byId.get(a.participantId);
      if (!p) {
        res.status(404).json({ error: 'PARTICIPANT_NOT_FOUND', participantId: a.participantId });
        return;
      }
      if (a.groupId != null && !groupIds.has(Number(a.groupId))) {
        res.status(400).json({ error: 'Unknown group for this research' });
        return;
      }
      const target = a.groupId == null ? null : Number(a.groupId);
      if (p.Started && p.GroupId !== target) {
        res.status(409).json({ error: 'GROUP_LOCKED', participantId: a.participantId });
        return;
      }
    }
    for (const a of assignments) {
      const p = byId.get(a.participantId);
      const target = a.groupId == null ? null : Number(a.groupId);
      if (p.GroupId === target) continue;
      await sql`
        UPDATE "Participant"
        SET "GroupId" = ${target},
            "GroupAssignedBy" = ${target == null ? null : 'RESEARCHER'},
            "GroupAssignedAt" = ${target == null ? null : new Date().toISOString()},
            "GroupAssignmentRunId" = NULL
        WHERE "Guid" = ${p.Guid}
      `;
    }
    res.json({ ok: true, updated: assignments.length });
  } catch (err) {
    console.error('[research-design] assign error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:researchId/participants/:participantId/group', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const { groupId } = req.body ?? {};
  if (groupId != null && !Number.isInteger(Number(groupId))) {
    res.status(400).json({ error: 'Invalid groupId' });
    return;
  }
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    const groups = await loadGroups(sql, researchId);
    if (groupId != null && !groups.some((g) => g.Id === Number(groupId))) {
      res.status(400).json({ error: 'Unknown group for this research' });
      return;
    }
    const people = await loadParticipants(sql, researchId, [req.params.participantId]);
    const p = people[0];
    if (!p) {
      res.status(404).json({ error: 'PARTICIPANT_NOT_FOUND' });
      return;
    }
    const target = groupId == null ? null : Number(groupId);
    if (p.Started && p.GroupId !== target) {
      res.status(409).json({ error: 'GROUP_LOCKED' });
      return;
    }
    await sql`
      UPDATE "Participant"
      SET "GroupId" = ${target},
          "GroupAssignedBy" = ${target == null ? null : 'RESEARCHER'},
          "GroupAssignedAt" = ${target == null ? null : new Date().toISOString()},
          "GroupAssignmentRunId" = NULL
      WHERE "Guid" = ${p.Guid}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[research-design] set group error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// One participant's task. Locked once the participant's protocol has started, like the group.
router.put('/:researchId/participants/:participantId/task', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const { taskId } = req.body ?? {};
  if (taskId != null && !Number.isInteger(Number(taskId))) {
    res.status(400).json({ error: 'Invalid taskId' });
    return;
  }
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    const tasks = await loadTasks(sql, researchId);
    if (taskId != null && !tasks.some((t) => t.Id === Number(taskId))) {
      res.status(400).json({ error: 'Unknown task for this research' });
      return;
    }
    const people = await sql`
      SELECT p."Guid", p."ResearchTaskId",
             EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid") AS "Started"
      FROM "Participant" p WHERE p."ResearchId" = ${researchId} AND p."ParticipantId" = ${req.params.participantId}
    `;
    const p = people[0];
    if (!p) {
      res.status(404).json({ error: 'PARTICIPANT_NOT_FOUND' });
      return;
    }
    const target = taskId == null ? null : Number(taskId);
    if (p.Started && p.ResearchTaskId !== target) {
      res.status(409).json({ error: 'TASK_LOCKED' });
      return;
    }
    await sql`
      UPDATE "Participant"
      SET "ResearchTaskId" = ${target}, "TaskAssignedBy" = ${target == null ? null : 'RESEARCHER'},
          "TaskAssignedAt" = ${target == null ? null : new Date().toISOString()}
      WHERE "Guid" = ${p.Guid}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[research-design] set task error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Balanced random assignment of every participant that still needs a group and/or a task (or just the ones listed):
// groups first, then the tasks inside every group. preview:true only computes and returns the allocation + the seed;
// without it the allocation is written and a GroupAssignmentRun keeps the seed and all inputs so it can be reproduced.
// reset:true also re-draws the participants that have not started and got their values from a previous random run.
router.post('/:researchId/randomize', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const { participantIds, seed: seedIn, preview, reset } = req.body ?? {};
  if (participantIds != null && (!Array.isArray(participantIds) || participantIds.some((x) => typeof x !== 'string'))) {
    res.status(400).json({ error: 'participantIds must be an array of strings' });
    return;
  }
  if (seedIn != null && (typeof seedIn !== 'string' || !seedIn.trim() || seedIn.length > 64)) {
    res.status(400).json({ error: 'seed is a non-empty string of up to 64 characters' });
    return;
  }
  try {
    const sql = getDb();
    const research = await requireProtocolResearch(sql, res, researchId);
    if (!research) return;
    const plan = await planAssignment(sql, researchId, { participantIds: participantIds ?? null, seed: seedIn, reset: reset === true });
    if (plan.error) {
      const status = plan.error === 'PARTICIPANT_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: plan.error, ...(plan.participantId ? { participantId: plan.participantId } : {}) });
      return;
    }
    const { summary, cells } = summarize(plan);
    const result = plan.assignments.map((a) => ({ participantId: a.participant, groupId: a.groupId, taskId: a.taskId }));
    if (preview === true) {
      res.json({ preview: true, seed: plan.seed, assignments: result, summary, cells });
      return;
    }
    const { runId } = await applyAssignment(sql, researchId, plan, { createdBy: req.researcher.id ?? null });
    res.json({ preview: false, seed: plan.seed, runId, assignments: result, summary, cells });
  } catch (err) {
    console.error('[research-design] randomize error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── the written task as a PDF (2026-10-30) ───────────────────────────────────────────────────────────────
// One PDF per task, stored in the row (Sql/041). The participant reads it in the sheets app; this router only lets the researcher
// upload, view and remove it. Uploaded separately from the design document (a task needs an id first), and the document save never
// touches the PDF columns.
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });
function uploadPdf(req, res, next) {
  pdfUpload.single('pdf')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'PDF_TOO_LARGE' });
        return;
      }
      console.error('[research-design] pdf upload error:', err);
      res.status(400).json({ error: 'INVALID_UPLOAD' });
      return;
    }
    next();
  });
}

function parseTaskId(req, res) {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: 'Invalid task id' });
    return null;
  }
  return taskId;
}

/** multer reads the header bytes as latin1; a UTF-8 file name ("zadatak č.pdf") has to be re-decoded. */
const fixFilename = (name) => {
  const decoded = Buffer.from(String(name ?? ''), 'latin1').toString('utf8');
  return (decoded.includes('\uFFFD') ? String(name) : decoded).replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 255) || 'zadatak.pdf';
};

router.put('/:researchId/tasks/:taskId/pdf', uploadPdf, async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const taskId = parseTaskId(req, res);
  if (taskId == null) return;
  const file = req.file;
  if (!file || !file.buffer?.length) {
    res.status(400).json({ error: 'PDF_REQUIRED' });
    return;
  }
  // A real PDF starts with "%PDF-" (a few bytes of junk before it are tolerated, as readers do).
  if (!file.buffer.subarray(0, 1024).includes('%PDF-')) {
    res.status(400).json({ error: 'NOT_A_PDF' });
    return;
  }
  try {
    const sql = getDb();
    if (!(await requireProtocolResearch(sql, res, researchId))) return;
    const name = fixFilename(file.originalname);
    const rows = await sql`
      UPDATE "ResearchTask"
      SET "PdfFilename" = ${name}, "PdfData" = ${file.buffer}, "PdfSize" = ${file.size}, "PdfUpdatedAt" = NOW()
      WHERE "Id" = ${taskId} AND "ResearchId" = ${researchId}
      RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, hasPdf: true, pdfName: name, pdfSize: file.size });
  } catch (err) {
    console.error('[research-design] pdf save error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/tasks/:taskId/pdf', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  const taskId = parseTaskId(req, res);
  if (taskId == null) return;
  try {
    const sql = getDb();
    const rows = await sql`SELECT "PdfFilename", "PdfData" FROM "ResearchTask" WHERE "Id" = ${taskId} AND "ResearchId" = ${researchId} LIMIT 1`;
    if (!rows[0]?.PdfData) {
      res.status(404).json({ error: 'PDF_NOT_FOUND' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="task-${taskId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(rows[0].PdfData));
  } catch (err) {
    console.error('[research-design] pdf read error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:researchId/tasks/:taskId/pdf', async (req, res) => {
  const researchId = parseResearchId(req, res);
  if (researchId == null) return;
  if (!requireWrite(req, res, researchId)) return;
  const taskId = parseTaskId(req, res);
  if (taskId == null) return;
  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "ResearchTask" SET "PdfFilename" = NULL, "PdfData" = NULL, "PdfSize" = NULL, "PdfUpdatedAt" = NULL
      WHERE "Id" = ${taskId} AND "ResearchId" = ${researchId} RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'TASK_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[research-design] pdf delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
