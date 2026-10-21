// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 — the rtr-html-v1 content model on the client.
//
// Stored content is ALLOWLISTED HTML: top-level p · h2 · ul · ol (li inside), inline
// b · i · u · br, governed field chips `<span data-field="key"></span>` (empty), and at most
// one `<div data-asset="tenant.logo"></div>` as the FIRST child. The server sanitizes on
// PATCH and is authoritative; this module re-sanitizes CLIENT-SIDE before anything is
// edited or rendered (never trust a string as markup). Parsing uses an inert <template>
// (scripts never run, images never load) and output is rebuilt node-by-node from the
// allowlist with no attributes other than data-field / data-asset (and, for server sample
// previews only, data-sample) — so the result can be serialised safely.

export type BlockKind = 'p' | 'h2' | 'ul' | 'ol';
export interface HtmlBlock { readonly kind: BlockKind; readonly value: string } // value = canonical inner HTML

export const LOGO_HTML = '<div data-asset="tenant.logo"></div>';
const KEY_RE = /^[A-Za-z0-9_.]+$/;
const DROP = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'SVG', 'MATH',
  'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'FRAME', 'FRAMESET', 'BASE',
]);
const MARK: Record<string, 'b' | 'i' | 'u'> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' };
const BLOCKISH = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'ASIDE', 'MAIN', 'NAV', 'FIGURE', 'ADDRESS', 'DL', 'DT', 'DD', 'HR']);

export function parseFragment(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

function cleanText(s: string): string { return s.replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' '); }
export function escapeText(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function isLogoDiv(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'DIV' && (n as Element).getAttribute('data-asset') === 'tenant.logo';
}

function fieldSpan(key: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.setAttribute('data-field', key);
  return s;
}

// Append sanitized INLINE content of `nodes` into `out`. Nested block boundaries become <br>.
function sanitizeInline(nodes: ArrayLike<Node>, out: Node, allowSample: boolean): void {
  const list = Array.from(nodes);
  list.forEach((n, idx) => {
    if (n.nodeType === Node.TEXT_NODE) { const t = cleanText(n.textContent ?? ''); if (t !== '') out.appendChild(document.createTextNode(t)); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    const tag = e.tagName;
    if (DROP.has(tag)) return;
    if (tag === 'BR') { out.appendChild(document.createElement('br')); return; }
    const key = e.getAttribute('data-field');
    if (tag === 'SPAN' && key != null) { if (KEY_RE.test(key)) out.appendChild(fieldSpan(key)); return; }
    const sample = e.getAttribute('data-sample');
    if (allowSample && tag === 'SPAN' && sample != null) {
      if (!KEY_RE.test(sample)) return;
      const s = document.createElement('span');
      s.setAttribute('data-sample', sample);
      s.appendChild(document.createTextNode(cleanText(e.textContent ?? '')));
      out.appendChild(s);
      return;
    }
    const m = MARK[tag];
    if (m != null) {
      const w = document.createElement(m);
      sanitizeInline(e.childNodes, w, allowSample);
      if (w.childNodes.length > 0) out.appendChild(w);
      return;
    }
    if (isLogoDiv(e)) return;
    sanitizeInline(e.childNodes, out, allowSample); // unwrap anything else
    if (BLOCKISH.has(tag) && idx < list.length - 1 && out.lastChild != null && out.lastChild.nodeName !== 'BR') out.appendChild(document.createElement('br'));
  });
}

function trimBr(el: Element): void {
  while (el.lastChild != null && el.lastChild.nodeName === 'BR') el.removeChild(el.lastChild);
}

// Sanitize a whole stored document to canonical rtr-html-v1. Returns canonical HTML.
export function sanitizeDocHtml(html: string, opts: { allowSample?: boolean } = {}): string {
  const allowSample = opts.allowSample === true;
  const out = document.createElement('div');
  let openP: HTMLElement | null = null;
  let openList: HTMLElement | null = null;
  const closeOpen = () => { if (openP != null) { trimBr(openP); if (openP.childNodes.length === 0) openP.remove(); } openP = null; openList = null; };

  const walk = (nodes: ArrayLike<Node>, top: boolean) => {
    for (const n of Array.from(nodes)) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element;
        const tag = e.tagName;
        if (DROP.has(tag)) continue;
        if (isLogoDiv(e)) {
          if (top && out.childNodes.length === 0 && openP == null) { const d = document.createElement('div'); d.setAttribute('data-asset', 'tenant.logo'); out.appendChild(d); }
          continue;
        }
        if (tag === 'P' || /^H[1-6]$/.test(tag)) {
          closeOpen();
          const b = document.createElement(tag === 'P' ? 'p' : 'h2');
          sanitizeInline(e.childNodes, b, allowSample);
          trimBr(b);
          out.appendChild(b);
          continue;
        }
        if (tag === 'UL' || tag === 'OL') {
          closeOpen();
          const l = document.createElement(tag.toLowerCase());
          for (const c of Array.from(e.childNodes)) {
            if (c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim() === '') continue;
            const li = document.createElement('li');
            sanitizeInline(c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName === 'LI' ? c.childNodes : [c], li, allowSample);
            trimBr(li);
            l.appendChild(li);
          }
          if (l.childNodes.length === 0) l.appendChild(document.createElement('li'));
          out.appendChild(l);
          continue;
        }
        if (tag === 'LI') {
          if (openList == null) { closeOpen(); openList = document.createElement('ul'); out.appendChild(openList); }
          const li = document.createElement('li');
          sanitizeInline(e.childNodes, li, allowSample);
          trimBr(li);
          openList.appendChild(li);
          continue;
        }
        if (BLOCKISH.has(tag) || tag === 'BODY' || tag === 'HTML') { closeOpen(); walk(e.childNodes, top); closeOpen(); continue; }
      } else if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === '' && openP == null) {
        continue;
      }
      // Stray inline content at top level → an implicit paragraph.
      if (openP == null) { openList = null; openP = document.createElement('p'); out.appendChild(openP); }
      sanitizeInline([n], openP, allowSample);
    }
  };
  walk(parseFragment(html).childNodes, true);
  closeOpen();
  return out.innerHTML;
}

// Sanitize PASTED html to an inline fragment (allowlisted marks, chips, <br> line breaks).
export function sanitizePastedInline(html: string): string {
  const out = document.createElement('div');
  sanitizeInline(parseFragment(html).childNodes, out, false);
  trimBr(out);
  return out.innerHTML;
}

// Canonical inner HTML of one block (marks merged, empties dropped, trailing <br> trimmed).
export function canonicalInner(kind: BlockKind, inner: string): string {
  const html = sanitizeDocHtml(`<${kind}>${inner}</${kind}>`);
  const first = parseFragment(html).firstElementChild;
  if (first == null) return kind === 'ul' || kind === 'ol' ? '<li></li>' : '';
  return mergeMarks(first.innerHTML);
}
function mergeMarks(s: string): string {
  let prev = '';
  let cur = s;
  while (prev !== cur) { prev = cur; cur = cur.replace(/<\/(b|i|u)><\1>/g, '').replace(/<(b|i|u)><\/\1>/g, ''); }
  return cur;
}

// Stored document → editor model.
export function htmlToBlocks(html: string): { logo: boolean; blocks: HtmlBlock[] } {
  const clean = sanitizeDocHtml(html);
  let logo = false;
  const blocks: HtmlBlock[] = [];
  for (const c of Array.from(parseFragment(clean).children)) {
    if (isLogoDiv(c)) { logo = true; continue; }
    const kind = c.tagName.toLowerCase() as BlockKind;
    blocks.push({ kind, value: mergeMarks(c.innerHTML) });
  }
  return { logo, blocks };
}
// Editor model → stored document (joined HTML, no ids).
export function blocksToHtml(logo: boolean, blocks: readonly HtmlBlock[]): string {
  return (logo ? LOGO_HTML : '') + blocks.map((b) => `<${b.kind}>${b.value}</${b.kind}>`).join('');
}

// Convert a block's value between kinds (H / • / 1. toggles).
export function convertKind(value: string, from: BlockKind, to: BlockKind): string {
  const isList = (k: BlockKind) => k === 'ul' || k === 'ol';
  if (isList(from) === isList(to)) return value;
  if (isList(to)) {
    const lines = value.split(/<br\s*\/?>/i);
    return lines.map((l) => `<li>${l}</li>`).join('') || '<li></li>';
  }
  const items = Array.from(parseFragment(value).children).filter((c) => c.tagName === 'LI').map((li) => li.innerHTML).filter((s) => s !== '');
  return canonicalInner(to, items.join('<br>'));
}

export function chipHtml(key: string): string { return `<span data-field="${key}"></span>`; }

// Used + unknown keys in a block value (chips + any [Label] text not yet normalised).
export function scanHtml(value: string, labelToKey: Record<string, string>, known: (k: string) => boolean): { used: string[]; bad: string[] } {
  const used: string[] = [];
  const bad: string[] = [];
  const frag = parseFragment(value);
  frag.querySelectorAll('[data-field]').forEach((e) => {
    const k = e.getAttribute('data-field') ?? '';
    if (known(k)) { if (!used.includes(k)) used.push(k); } else if (!bad.includes(k)) bad.push(k);
  });
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n != null; n = walker.nextNode()) {
    for (const m of (n.textContent ?? '').matchAll(/\[([^\]]+)\]/g)) {
      const l = (m[1] ?? '').trim();
      const k = labelToKey[l];
      if (k != null) { if (!used.includes(k)) used.push(k); } else if (!bad.includes(l)) bad.push(l);
    }
  }
  return { used, bad };
}
export function isHtmlEmpty(value: string): boolean {
  const frag = parseFragment(value);
  return frag.querySelector('[data-field]') == null && (frag.textContent ?? '').trim() === '';
}

// ── Inline marks on a live selection (Range-based; normalised to b/i/u) ──────
const EQUIV: Record<'b' | 'i' | 'u', readonly string[]> = { b: ['B', 'STRONG'], i: ['I', 'EM'], u: ['U'] };

function markAncestor(node: Node | null, root: Element, tag: 'b' | 'i' | 'u'): Element | null {
  let n: Node | null = node;
  while (n != null && n !== root) {
    if (n.nodeType === Node.ELEMENT_NODE && EQUIV[tag].includes((n as Element).tagName)) return n as Element;
    n = n.parentNode;
  }
  return null;
}
export function activeMarks(root: Element | null, range: Range | null): { b: boolean; i: boolean; u: boolean } {
  if (root == null || range == null || !root.contains(range.startContainer)) return { b: false, i: false, u: false };
  return {
    b: markAncestor(range.startContainer, root, 'b') != null,
    i: markAncestor(range.startContainer, root, 'i') != null,
    u: markAncestor(range.startContainer, root, 'u') != null,
  };
}
function chipOf(n: Node, root: Element): Element | null {
  const e = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  const c = e?.closest('[data-field],[data-bad],[data-bad-field]') ?? null;
  return c != null && root.contains(c) && c !== root ? c : null;
}
function unwrap(e: Element): void {
  const p = e.parentNode;
  if (p == null) return;
  while (e.firstChild != null) p.insertBefore(e.firstChild, e);
  p.removeChild(e);
}

// Toggle b/i/u on the selection inside `root`. Returns true when the DOM changed.
export function toggleMark(root: HTMLElement, range: Range | null, tag: 'b' | 'i' | 'u'): boolean {
  if (range == null || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
  const r = range.cloneRange();
  const sc = chipOf(r.startContainer, root);
  if (sc != null) r.setStartBefore(sc);
  const ec = chipOf(r.endContainer, root);
  if (ec != null) r.setEndAfter(ec);
  const on = markAncestor(r.startContainer, root, tag) != null && markAncestor(r.endContainer, root, tag) != null;
  if (on) {
    const marks = Array.from(root.querySelectorAll(EQUIV[tag].join(','))).filter((m) => r.intersectsNode(m));
    marks.forEach(unwrap);
    return marks.length > 0;
  }
  const lists = Array.from(root.querySelectorAll('li')).filter((li) => r.intersectsNode(li));
  const containers: Element[] = lists.length > 0 ? lists : [root];
  const wrapped: Element[] = [];
  for (const c of containers) {
    const sub = document.createRange();
    sub.selectNodeContents(c);
    if (c.contains(r.startContainer)) sub.setStart(r.startContainer, r.startOffset);
    if (c.contains(r.endContainer)) sub.setEnd(r.endContainer, r.endOffset);
    if (sub.collapsed) continue;
    const frag = sub.extractContents();
    const w = document.createElement(tag);
    w.appendChild(frag);
    Array.from(w.querySelectorAll(EQUIV[tag].join(','))).forEach(unwrap);
    sub.insertNode(w);
    wrapped.push(w);
  }
  const first = wrapped[0];
  const last = wrapped[wrapped.length - 1];
  if (first != null && last != null && typeof window.getSelection === 'function') {
    const sel = window.getSelection();
    const nr = document.createRange();
    nr.setStart(first, 0);
    nr.setEnd(last, last.childNodes.length);
    sel?.removeAllRanges();
    sel?.addRange(nr);
  }
  return wrapped.length > 0;
}
