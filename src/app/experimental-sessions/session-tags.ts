/**
 * Predefined "hashtag" vocabulary for individual participant-sessions (Experimental Session
 * detail page). Mirrors PREDEFINED_TAGS in
 * server/experimental-sessions/routes.mjs — keep both lists in sync; the server is the source of
 * truth for validation, this one is only for rendering the picker + translated/toned chip labels.
 * A tag outside this list is still allowed as free-form "custom" (always rendered neutral).
 */

// One tag per participant-session — more than one made the table row wrap/grow unpredictably
// (variable-width chips stacking), and a single flag is enough to mark "what happened" at a
// glance. Server-side validation in experimental-sessions/routes.mjs mirrors this.
export const MAX_TAGS = 1;

export type TagTone = 'positive' | 'negative' | 'neutral';

export interface PredefinedTag {
  id: string;
  labelSr: string;
  labelEn: string;
  tone: TagTone;
}

export const PREDEFINED_TAGS: PredefinedTag[] = [
  { id: 'SUCCESS', labelSr: 'Uspešno', labelEn: 'Successful', tone: 'positive' },
  { id: 'CORRUPTED', labelSr: 'Oštećeno', labelEn: 'Corrupted', tone: 'negative' },
  { id: 'INTERRUPTED', labelSr: 'Prekinuto', labelEn: 'Interrupted', tone: 'negative' },
  { id: 'TECHNICAL_ISSUE', labelSr: 'Tehnički problem', labelEn: 'Technical issue', tone: 'negative' },
  { id: 'REPEAT_NEEDED', labelSr: 'Potrebno ponoviti', labelEn: 'Repeat needed', tone: 'neutral' },
  { id: 'NOTEWORTHY', labelSr: 'Vredno pažnje', labelEn: 'Noteworthy', tone: 'neutral' },
];

export function predefinedTagLabel(id: string, lang: string): string {
  const tag = PREDEFINED_TAGS.find((t) => t.id === id);
  if (!tag) return id;
  return lang === 'en' ? tag.labelEn : tag.labelSr;
}

export function predefinedTagTone(id: string): TagTone | null {
  return PREDEFINED_TAGS.find((t) => t.id === id)?.tone ?? null;
}
