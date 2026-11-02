// Planning and applying the automatic group + task assignment of a research (2026-10-30).
//
// Used by the "randomize" route of the research design (preview / confirm) and by the participant import (assigns the
// newly imported people right away). Pure planning lives in randomize.mjs; this file is the database side.

import crypto from 'node:crypto';
import { randomizeStratified } from './randomize.mjs';

export const MAX_ASSIGN = 2000;

export async function loadGroups(sql, researchId) {
  return sql`SELECT "Id","Name","Weight" FROM "ResearchGroup" WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder","Id"`;
}

export async function loadTasks(sql, researchId) {
  return sql`SELECT "Id","Name","Weight" FROM "ResearchTask" WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder","Id"`;
}

/** True when the research has something to assign (two or more groups, or two or more tasks). */
export const hasAssignableDesign = (groups, tasks) => groups.length >= 2 || tasks.length >= 2;

/**
 * Works out who gets which group and task. Nothing is written.
 *
 * @param {object} opts
 * @param {string[]|null} opts.participantIds  only these (public ParticipantIds), or null for everybody who still needs something
 * @param {string} opts.seed
 * @param {boolean} [opts.reset]  also re-draw the participants that have not started and were assigned by a previous random run
 *                                (values the researcher or the Excel sheet set are never touched)
 * @returns {Promise<{ error?: string, seed?: string, toPlace?: object[], groups: object[], tasks: object[],
 *                     assignments?: object[], groupCounts?: object, cellCounts?: object, people?: object[], existing?: object }>}
 */
export async function planAssignment(sql, researchId, { participantIds = null, seed, reset = false }) {
  const [groups, tasks] = await Promise.all([loadGroups(sql, researchId), loadTasks(sql, researchId)]);
  if (!hasAssignableDesign(groups, tasks)) return { error: 'NEED_TWO_GROUPS', groups, tasks };

  const all = await sql`
    SELECT p."Guid", p."ParticipantId", p."GroupId", p."ResearchTaskId", p."GroupAssignedBy", p."TaskAssignedBy",
           EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid") AS "Started"
    FROM "Participant" p WHERE p."ResearchId" = ${researchId}
  `;
  const wanted = participantIds ? new Set(participantIds) : null;
  if (wanted) {
    const known = new Set(all.map((p) => p.ParticipantId));
    const unknown = [...wanted].find((id) => !known.has(id));
    if (unknown) return { error: 'PARTICIPANT_NOT_FOUND', participantId: unknown, groups, tasks };
  }

  // A factor counts only when it has two or more levels (one group or one task cannot split anybody).
  const useGroups = groups.length >= 2;
  const useTasks = tasks.length >= 2;
  // What each participant still needs. `reset` frees the random values of the ones that have not started.
  const freeGroup = (p) => reset && useGroups && !p.Started && p.GroupAssignedBy === 'RANDOM';
  const freeTask = (p) => reset && useTasks && !p.Started && p.TaskAssignedBy === 'RANDOM';
  const view = (p) => ({
    id: p.ParticipantId,
    guid: p.Guid,
    groupId: freeGroup(p) ? null : p.GroupId,
    taskId: freeTask(p) ? null : p.ResearchTaskId,
    hadGroup: p.GroupId,
    hadTask: p.ResearchTaskId,
  });
  const needs = (v, p) => !p.Started && ((useGroups && v.groupId == null) || (useTasks && v.taskId == null));
  const people = [];
  const existing = { groups: {}, cells: {} };
  for (const p of all) {
    const v = view(p);
    const inScope = !wanted || wanted.has(p.ParticipantId);
    if (inScope && needs(v, p)) {
      people.push(v);
    } else {
      // Not placed now, but counted so the groups and the cells end up balanced overall.
      if (useGroups && p.GroupId != null) existing.groups[p.GroupId] = (existing.groups[p.GroupId] ?? 0) + 1;
      if (useTasks && p.ResearchTaskId != null && (!useGroups || p.GroupId != null)) {
        const k = `${useGroups ? p.GroupId : 0}:${p.ResearchTaskId}`;
        existing.cells[k] = (existing.cells[k] ?? 0) + 1;
      }
    }
  }
  if (!people.length) return { error: 'NOTHING_TO_ASSIGN', groups, tasks };
  if (people.length > MAX_ASSIGN) return { error: 'TOO_MANY', groups, tasks };

  const usedSeed = seed?.trim() || crypto.randomBytes(8).toString('hex');
  const planned = randomizeStratified({
    people: people.map((v) => ({ id: v.id, groupId: v.groupId, taskId: v.taskId })),
    groups: useGroups ? groups.map((g) => ({ id: g.Id, weight: g.Weight })) : [],
    tasks: useTasks ? tasks.map((t) => ({ id: t.Id, weight: t.Weight })) : [],
    existing,
    seed: usedSeed,
  });
  return { seed: usedSeed, groups, tasks, useGroups, useTasks, people, existing, ...planned };
}

/** Counts per group and per (group, task) cell that a plan produces, with names, for the researcher's summary. */
export function summarize(plan) {
  const groupName = new Map(plan.groups.map((g) => [g.Id, g.Name]));
  const taskName = new Map(plan.tasks.map((t) => [t.Id, t.Name]));
  const byGroup = (plan.useGroups ? plan.groups : []).map((g) => ({
    groupId: g.Id,
    name: g.Name,
    added: plan.assignments.filter((a) => a.groupId === g.Id).length,
    total: plan.groupCounts[g.Id] ?? 0,
  }));
  const cells = [];
  const groupKeys = plan.useGroups ? plan.groups.map((g) => g.Id) : [null];
  for (const gid of groupKeys) {
    for (const t of plan.useTasks ? plan.tasks : []) {
      cells.push({
        groupId: gid,
        groupName: gid == null ? null : groupName.get(gid),
        taskId: t.Id,
        taskName: taskName.get(t.Id),
        added: plan.assignments.filter((a) => a.groupId === gid && a.taskId === t.Id).length,
        total: plan.cellCounts[`${gid ?? 0}:${t.Id}`] ?? 0,
      });
    }
  }
  return { summary: byGroup, cells };
}

/** Writes a plan: one GroupAssignmentRun row (inputs kept, so the draw can be reproduced) and the participants' values. */
export async function applyAssignment(sql, researchId, plan, { createdBy = null } = {}) {
  const weights = Object.fromEntries(plan.groups.map((g) => [g.Id, g.Weight]));
  const params = {
    groups: (plan.useGroups ? plan.groups : []).map((g) => ({ id: g.Id, name: g.Name, weight: g.Weight })),
    tasks: (plan.useTasks ? plan.tasks : []).map((t) => ({ id: t.Id, name: t.Name, weight: t.Weight })),
    existing: plan.existing,
    people: plan.people.map((v) => ({ id: v.id, groupId: v.groupId, taskId: v.taskId })),
  };
  const run = await sql`
    INSERT INTO "GroupAssignmentRun" ("ResearchId","Method","Seed","Weights","Count","CreatedBy","Params")
    VALUES (${researchId}, ${plan.useTasks ? 'STRATIFIED' : 'BALANCED'}, ${plan.seed}, ${JSON.stringify(weights)}::jsonb,
            ${plan.assignments.length}, ${createdBy}, ${JSON.stringify(params)}::jsonb)
    RETURNING "Id"
  `;
  const runId = run[0].Id;
  const byId = new Map(plan.people.map((v) => [v.id, v]));
  const now = new Date().toISOString();
  for (const a of plan.assignments) {
    const v = byId.get(a.participant);
    // Only what was missing (or freed by `reset`) is written; a value that was given stays as it is.
    const newGroup = plan.useGroups && v.groupId == null ? a.groupId : null;
    const newTask = plan.useTasks && v.taskId == null ? a.taskId : null;
    if (newGroup != null) {
      await sql`
        UPDATE "Participant"
        SET "GroupId" = ${newGroup}, "GroupAssignedBy" = ${newGroup == null ? null : 'RANDOM'},
            "GroupAssignedAt" = ${newGroup == null ? null : now}, "GroupAssignmentRunId" = ${newGroup == null ? null : runId}
        WHERE "Guid" = ${v.guid}
      `;
    }
    if (newTask != null) {
      await sql`
        UPDATE "Participant"
        SET "ResearchTaskId" = ${newTask}, "TaskAssignedBy" = ${newTask == null ? null : 'RANDOM'}, "TaskAssignedAt" = ${newTask == null ? null : now}
        WHERE "Guid" = ${v.guid}
      `;
    }
  }
  return { runId };
}
