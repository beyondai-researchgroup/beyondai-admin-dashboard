// Balanced random assignment of participants to groups (2026-10).
//
// Pure functions so they can be tested without a database. The method is a seeded "largest deficit"
// allocation: the sizes of the groups always follow their weights (equal weights give sizes that differ
// by at most one, 2:1 gives twice as many in the first group, ...), ties are broken at random, and
// which participant lands in which slot is a seeded shuffle. The same participants + weights + seed
// always give the same result, which is what makes a run reproducible from its stored seed.

/** 32-bit FNV-1a hash of a string — turns any text seed into a number for the PRNG. */
export function seedToInt(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, well-distributed seeded PRNG returning floats in [0, 1). */
export function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} p
 * @param {string[]} p.participants     ids of the participants to place (no group yet)
 * @param {{id:number, weight:number}[]} p.groups
 * @param {Record<string, number>} [p.existingCounts]  participants already in each group (by group id)
 * @param {string} p.seed
 * @returns {{ assignments: {participant:string, groupId:number}[], counts: Record<string, number> }}
 */
export function randomizeBalanced({ participants, groups, existingCounts = {}, seed }) {
  if (!groups.length) throw new Error('At least one group is required');
  const rand = mulberry32(seedToInt(seed));
  const counts = {};
  for (const g of groups) counts[g.id] = existingCounts[g.id] ?? 0;
  const totalWeight = groups.reduce((s, g) => s + g.weight, 0);
  let placed = groups.reduce((s, g) => s + counts[g.id], 0);

  // Sort first so the outcome does not depend on the order the caller happened to pass the ids in.
  const people = [...participants].sort();
  const slots = [];
  for (let k = 0; k < people.length; k++) {
    let best = [];
    let bestDeficit = -Infinity;
    for (const g of groups) {
      const deficit = (g.weight / totalWeight) * (placed + 1) - counts[g.id];
      if (deficit > bestDeficit + 1e-9) {
        bestDeficit = deficit;
        best = [g];
      } else if (Math.abs(deficit - bestDeficit) <= 1e-9) {
        best.push(g);
      }
    }
    const chosen = best.length === 1 ? best[0] : best[Math.floor(rand() * best.length)];
    counts[chosen.id] += 1;
    placed += 1;
    slots.push(chosen.id);
  }

  // Fisher-Yates over the participants (seeded), then pair them with the slots in order.
  const shuffled = [...people];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const assignments = shuffled.map((participant, i) => ({ participant, groupId: slots[i] }));
  return { assignments, counts };
}

/**
 * Two-factor balanced assignment (2026-10-30): groups first, then, inside every group, tasks. Both steps use
 * randomizeBalanced, so the groups follow their weights and, inside each group, the tasks follow theirs (equal
 * weights: the sizes of two tasks in a group differ by at most one). The seed of each group's task draw is derived
 * from the main seed, so the whole result is reproducible from it.
 *
 * @param {object} p
 * @param {{id:string, groupId:number|null, taskId:number|null}[]} p.people  to place; a value already set is kept and
 *        only counted (a participant can arrive with a group from the Excel sheet and still need a task)
 * @param {{id:number, weight:number}[]} p.groups
 * @param {{id:number, weight:number}[]} p.tasks   may be empty (then only groups are assigned)
 * @param {{groups?: Record<string, number>, cells?: Record<string, number>}} [p.existing]
 *        participants NOT in `people` that are already placed: per group, and per "groupId:taskId" cell
 * @param {string} p.seed
 * @returns {{ assignments: {participant:string, groupId:number|null, taskId:number|null}[],
 *             groupCounts: Record<string, number>, cellCounts: Record<string, number> }}
 */
export function randomizeStratified({ people, groups, tasks, existing = {}, seed }) {
  const groupCounts = {};
  const cellCounts = {};
  for (const g of groups) groupCounts[g.id] = existing.groups?.[g.id] ?? 0;
  for (const [k, n] of Object.entries(existing.cells ?? {})) cellCounts[k] = n;

  // Step 1: groups. Participants that already have one are only counted.
  const finalGroup = new Map(); // participant id -> group id (0 when the research has no groups)
  const needGroup = [];
  for (const p of people) {
    if (p.groupId != null) {
      finalGroup.set(p.id, p.groupId);
      groupCounts[p.groupId] = (groupCounts[p.groupId] ?? 0) + 1;
    } else if (groups.length) {
      needGroup.push(p.id);
    } else {
      finalGroup.set(p.id, 0);
    }
  }
  if (needGroup.length) {
    const placed = randomizeBalanced({ participants: needGroup, groups, existingCounts: { ...groupCounts }, seed });
    for (const a of placed.assignments) finalGroup.set(a.participant, a.groupId);
    for (const [g, n] of Object.entries(placed.counts)) groupCounts[g] = n;
  }

  // Step 2: tasks inside every group.
  const finalTask = new Map();
  for (const p of people) if (p.taskId != null) finalTask.set(p.id, p.taskId);
  if (tasks.length) {
    const groupKeys = groups.length ? groups.map((g) => g.id) : [0];
    for (const gid of groupKeys) {
      const members = people.filter((p) => finalGroup.get(p.id) === gid);
      for (const p of members) {
        if (p.taskId != null) cellCounts[`${gid}:${p.taskId}`] = (cellCounts[`${gid}:${p.taskId}`] ?? 0) + 1;
      }
      const need = members.filter((p) => p.taskId == null).map((p) => p.id);
      if (!need.length) continue;
      const existingCounts = {};
      for (const t of tasks) existingCounts[t.id] = cellCounts[`${gid}:${t.id}`] ?? 0;
      const placed = randomizeBalanced({ participants: need, groups: tasks, existingCounts, seed: `${seed}:g${gid}` });
      for (const a of placed.assignments) finalTask.set(a.participant, a.groupId);
      for (const t of tasks) cellCounts[`${gid}:${t.id}`] = placed.counts[t.id];
    }
  }

  const assignments = people
    .map((p) => ({
      participant: p.id,
      groupId: groups.length ? (finalGroup.get(p.id) ?? null) : null,
      taskId: finalTask.get(p.id) ?? null,
    }))
    .sort((a, b) => (a.participant < b.participant ? -1 : a.participant > b.participant ? 1 : 0));
  return { assignments, groupCounts, cellCounts };
}
