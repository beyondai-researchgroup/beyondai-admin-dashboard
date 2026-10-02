// Route scope-guard audit (2026-09-09) — a lightweight, repeatable check for the one rule
// scope.mjs's own header comment names as "every participants/results route must follow":
// resolve access via `resolveResearchScope`, never trust a raw client-supplied researchId
// directly. Isolation across researches in this app has always relied on every new route
// remembering to call it — this script makes that a checkable fact instead of something only
// caught by manual code review (which has worked so far, but doesn't scale forever).
//
// Approach: parse server/index.mjs for the actual mounted routers (not a directory glob — this
// repo has route files that aren't named `routes.mjs`, e.g. researchers/directory.mjs,
// task-config/form-questions.mjs, and a directory glob would either miss them or need constant
// upkeep). Each mounted router is then classified as:
//   (a) imports resolveResearchScope from scope.mjs — the normal case, or
//   (b) imports requireSuperAdmin — an acceptable alternative gate (superadmin sees everything
//       by design, so there's no per-research scope left to check), or
//   (c) present in the ALLOWLIST below, each with its own one-line reason — genuinely public
//       (token-authenticated, no researcher session yet) or scoped to the researcher's own
//       identity/OAuth connection rather than a research at all.
// Anything matching none of the three is flagged. Run with `npm run audit:scope`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, '..', 'server');
const indexPath = resolve(serverDir, 'index.mjs');

// Reason each entry is legitimately unguarded — reviewed against this round's own exploration
// (2026-09-09), not just written to make the script pass. Keyed by the router file's path
// relative to server/, matching how it's imported from index.mjs.
const ALLOWLIST = {
  'auth/routes.mjs': 'public login endpoint — no researcher session exists yet to scope by',
  'researcher-invite/routes.mjs': 'public, token-authenticated (new-account accept flow) — the one-time token itself is the authentication',
  'team-invite/routes.mjs': 'public, token-authenticated (team-invite accept flow) — same trust model as researcher-invite',
  'researcher-profile/routes.mjs': 'requireAuth-gated but always scoped to req.researcher.id itself, never a research — no cross-research surface to guard',
  'notifications/routes.mjs': 'requireAuth-gated, always scoped to req.researcher.id, not per-research',
  'calendar/routes.mjs': 'per-researcher Google OAuth connection (status/connect/disconnect), not per-research; /oauth2callback is public by necessity (Google calls it)',
  'google-forms/routes.mjs': 'same shape as calendar/routes.mjs — per-researcher OAuth connection, public OAuth callback',
  'researchers/directory.mjs': 'directory listing exposes no sensitive/per-research fields, intentionally available to any authenticated researcher (feeds the add-existing-researcher-to-team flow)',
};

function parseIndex() {
  const src = readFileSync(indexPath, 'utf8');

  const imports = new Map(); // localName -> relative import path (e.g. './researches/routes.mjs')
  for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+'(\.\/[^']+)';/gm)) {
    imports.set(m[1], m[2]);
  }

  const mounts = []; // { mountPath, file }
  for (const m of src.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) {
    const [, mountPath, localName] = m;
    const importPath = imports.get(localName);
    if (importPath) mounts.push({ mountPath, file: importPath.replace(/^\.\//, '') });
  }
  return mounts;
}

function classify(file) {
  const content = readFileSync(resolve(serverDir, file), 'utf8');
  if (/resolveResearchScope/.test(content)) return { ok: true, via: 'resolveResearchScope' };
  if (/requireSuperAdmin/.test(content)) return { ok: true, via: 'requireSuperAdmin' };
  if (file in ALLOWLIST) return { ok: true, via: `allowlisted — ${ALLOWLIST[file]}` };
  return { ok: false, via: null };
}

const mounts = parseIndex();
if (!mounts.length) {
  console.error('audit-route-scope: found zero mounted routers in server/index.mjs — parser likely broken, treat as a failure.');
  process.exit(1);
}

let flagged = 0;
console.log(`Auditing ${mounts.length} mounted routers from server/index.mjs:\n`);
for (const { mountPath, file } of mounts) {
  const { ok, via } = classify(file);
  if (ok) {
    console.log(`  OK   ${mountPath.padEnd(34)} ${file.padEnd(38)} (${via})`);
  } else {
    flagged++;
    console.log(`  ⚠ FLAGGED  ${mountPath.padEnd(30)} ${file.padEnd(38)} no resolveResearchScope/requireSuperAdmin, not allowlisted`);
  }
}

console.log(`\n${mounts.length - flagged}/${mounts.length} passed, ${flagged} flagged.`);
process.exit(flagged > 0 ? 1 : 0);
