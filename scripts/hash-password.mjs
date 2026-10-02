#!/usr/bin/env node
// Usage: node scripts/hash-password.mjs <plaintext-password>
// (or: npm run hash-password -- <plaintext-password>)
//
// Prints a bcrypt hash. Kept mainly for one-off scripting/debugging — as of Phase B
// (2026-08-18) researcher accounts are normally created through the Admin Dashboard's own
// "Istraživači"/Researchers page (superadmin only), which handles hashing + research
// assignment (via the ResearcherResearch join table) itself. A manual insert still works if
// ever needed, e.g.:
//
//   INSERT INTO "Researcher" ("Username", "PasswordHash", "IsSuperAdmin")
//   VALUES ('andrej', '<paste-hash-here>', TRUE);
//   -- then, for a non-superadmin, assign at least one research:
//   INSERT INTO "ResearcherResearch" ("ResearcherId", "ResearchId") VALUES (<id>, <research-id>);
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs <password>');
  process.exit(1);
}

console.log(bcrypt.hashSync(password, 10));
