// Formatted text for the rules screen (2026-10): the researcher writes it in a rich-text editor, the participant reads it.
// It is stored as HTML, so every write AND every read goes through this allow-list: only the tags and CSS properties the
// editor can produce survive, scripts / event handlers / odd URL schemes / anything else are dropped. Older rules were
// plain text; those are turned into paragraphs here, so both kinds look the same to the rest of the app.

import sanitizeHtml from 'sanitize-html';

/** Upper bound for the stored HTML (the markup is much heavier than the visible text). */
export const MAX_RICH_TEXT = 40000;

const COLOR_HEX = /^#[0-9a-f]{3,8}$/i;
const COLOR_RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i;

const OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'span'],
  allowedAttributes: { '*': ['style'], a: ['href', 'target', 'rel'], ol: ['start'] },
  allowedStyles: {
    '*': {
      // Font names the editor offers, plus generic CSS family keywords — letters, digits, spaces, commas, quotes and hyphens only.
      'font-family': [/^[A-Za-z0-9 ,'"-]{1,120}$/],
      'font-size': [/^(1[0-9]|2[0-9]|3[0-6])px$/],
      'text-align': [/^(left|center|right|justify)$/],
      color: [COLOR_HEX, COLOR_RGB],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
};

export const sanitizeRichText = (html) => sanitizeHtml(String(html ?? ''), OPTIONS);

/** The visible text only (used for "is there anything written?"). */
export const richTextToPlain = (html) =>
  sanitizeHtml(String(html ?? ''), { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;|&#160;/g, ' ').trim();

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HTML_HINT = /<(p|h2|h3|ul|ol|li|blockquote|br|strong|em|u|s|b|i|span|a|hr)[\s>/]/i;

/** Plain text (older rules): blank lines separate paragraphs, single line breaks stay as line breaks. */
export function plainToHtml(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Anything the app stores or serves as rules: plain text or HTML in, safe HTML out; null when nothing visible is
 * written (an empty editor is `<p></p>`, which must not count as "there are rules").
 */
export function cleanRichText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const html = sanitizeRichText(HTML_HINT.test(value) ? value : plainToHtml(value));
  return richTextToPlain(html) ? html : null;
}
