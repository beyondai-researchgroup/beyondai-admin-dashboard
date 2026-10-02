// Research.Slug — the per-research path segment for the Consent app's entry point
// (consent-andrejkatin's /<slug> route, see server/consent-form/mailing-list.mjs's
// portal-link route). Generated once at research creation (POST /), never auto-regenerated on a
// name edit (a shared/emailed link must stay stable) — editable afterward via
// PUT /api/admin/consent-form/:researchId/slug.
const TRANSLITERATE = {
  č: 'c', ć: 'c', ž: 'z', š: 's', đ: 'dj',
  Č: 'c', Ć: 'c', Ž: 'z', Š: 's', Đ: 'dj',
};

const MAX_SLUG_LENGTH = 80;
const MAX_GENERATED_BASE_LENGTH = 60;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Unicode combining-diacritical-marks block — strips whatever a NFD normalize() split off any
// other accented Latin character not covered by the explicit Serbian map above (e.g. a stray
// German/French character in a research name).
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

export function slugify(text) {
  let s = String(text ?? '').split('').map((ch) => TRANSLITERATE[ch] ?? ch).join('');
  s = s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS_RE, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > MAX_GENERATED_BASE_LENGTH) s = s.slice(0, MAX_GENERATED_BASE_LENGTH).replace(/-+$/g, '');
  return s || 'research';
}

export function isValidSlug(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_SLUG_LENGTH && SLUG_RE.test(v);
}

// Appends -2, -3, ... until a free slug is found. excludeId lets an edit re-check "is this slug
// free, ignoring the row it already belongs to".
export async function generateUniqueSlug(sql, name, excludeId = null) {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  // Research count is tiny in practice (a handful of rows) — a simple loop is fine, no need for
  // a single clever query.
  for (;;) {
    const rows = excludeId != null
      ? await sql`SELECT 1 FROM "Research" WHERE "Slug" = ${candidate} AND "Id" != ${excludeId} LIMIT 1`
      : await sql`SELECT 1 FROM "Research" WHERE "Slug" = ${candidate} LIMIT 1`;
    if (!rows.length) return candidate;
    candidate = `${base}-${n}`;
    n++;
  }
}
