/**
 * Client-side counterpart of server/rich-text.mjs. The server already sanitizes the rules text on every write and read;
 * this is the second line of defence for the one place HTML is put on the page (the rules screen): only the tags and
 * CSS properties the editor can produce survive. Used instead of Angular's own sanitizer because that one removes
 * every `style` attribute (fonts, sizes, colours, alignment) from innerHTML.
 */

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'A', 'SPAN']);
/** Removed together with their content (unwrapping a <script> would turn its code into visible text). */
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA', 'SELECT']);

const COLOR_HEX = /^#[0-9a-f]{3,8}$/i;
const COLOR_RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i;
const STYLE_RULES: Record<string, RegExp[]> = {
  'font-family': [/^[A-Za-z0-9 ,'"-]{1,120}$/],
  'font-size': [/^(1[0-9]|2[0-9]|3[0-6])px$/],
  'text-align': [/^(left|center|right|justify)$/],
  color: [COLOR_HEX, COLOR_RGB],
};

function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim();
    if (STYLE_RULES[prop]?.some((re) => re.test(value))) kept.push(`${prop}: ${value}`);
  }
  return kept.join('; ');
}

function cleanElement(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name === 'style') {
      const style = cleanStyle(attr.value);
      if (style) el.setAttribute('style', style); else el.removeAttribute('style');
    } else if (el.tagName === 'A' && name === 'href') {
      if (!/^(https?:|mailto:)/i.test(attr.value.trim())) el.removeAttribute('href');
    } else if (el.tagName === 'OL' && name === 'start') {
      if (!/^\d{1,4}$/.test(attr.value)) el.removeAttribute('start');
    } else if (!(el.tagName === 'A' && (name === 'target' || name === 'rel'))) {
      el.removeAttribute(attr.name);
    }
  }
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

function cleanChildren(parent: Element): void {
  for (const child of Array.from(parent.children)) {
    if (DROP_WITH_CONTENT.has(child.tagName)) {
      child.remove();
    } else if (!ALLOWED_TAGS.has(child.tagName)) {
      // Unknown wrapper: keep what is inside it, drop the tag itself.
      const inner = Array.from(child.childNodes);
      child.replaceWith(...inner);
      cleanChildren(parent);
      return;
    } else {
      cleanElement(child);
      cleanChildren(child);
    }
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HTML_HINT = /<(p|h2|h3|ul|ol|li|blockquote|br|strong|em|u|s|b|i|span|a|hr)[\s>/]/i;

/** Older rules were plain text: blank lines separate paragraphs, single line breaks stay. */
export function plainToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Plain text or HTML in, HTML that is safe to put on the page out. */
export function toSafeHtml(value: string): string {
  const html = HTML_HINT.test(value) ? value : plainToHtml(value);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  cleanChildren(doc.body);
  return doc.body.innerHTML;
}

/** True when the formatted text has nothing visible in it (an empty editor is `<p></p>`). */
export function isRichTextEmpty(value: string): boolean {
  return !value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
