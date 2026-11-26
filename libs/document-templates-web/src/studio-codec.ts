// PLATFORM-UX-1 F-9 (directive R-11) — the Template Studio's content codec, built ON the
// existing rtr-html-v1 contract (dt-html) and the BlockCodec seam (dt-block-editor). This
// file only ADDS helpers; every existing export of this lib is unchanged (ats-web
// SendRtrModal and home-web keep consuming them byte-for-byte).
//
// The Studio edits an ordered list of blocks (p · h2 · ul · ol), each one an editable
// region whose variables are ATOMIC chips. Storage stays the A1 allowlist exactly:
//   <span data-field="talent.first_name"></span>   (the stored form of {{talent.first_name}})
// The chip shows the `{{key}}` token (the design's chip), carries data-field, and is
// serialised by HTML_CODEC's own serialiser, so the stored HTML is identical to what the
// RTR editor writes. `{{key}}` text (paste, clause text) becomes a chip through the same
// `{{token}}` rule HTML_CODEC.fromTemplate uses.

import {
  BLOCK_KINDS_V2,
  CURRENT_HTML_CONTENT_VERSION,
  LIST_MAX_DEPTH_V2,
  PAGE_BREAK_ATTR,
  PAGE_BREAK_VALUE,
  SIGN_FIELD_ATTR,
  isInlineFieldKey,
  PLACEHOLDER_TOKEN_SOURCE,
  placeholderKeysIn,
  placeholderTokenRe,
  CONTENT_KEY_RE as KEY_RE,
} from '@aramo/template-content';

import { HTML_CODEC, insertAtRange, serializeInlineHtml, type BlockCodec } from './dt-block-editor';
import {
  LOGO_HTML,
  activeMarks,
  blocksToHtml,
  canonicalInner,
  chipHtml,
  convertKind,
  escapeText,
  htmlToBlocks,
  isHtmlEmpty,
  parseFragment,
  sanitizeDocHtml,
  toggleMark,
  type BlockKind,
} from './dt-html';
import type { BindingMap } from './dt-ui';

export type StudioBlockKind = BlockKind;
/** The BlockCodec seam (dt-block-editor) the Studio editor drives. */
export type StudioCodec = BlockCodec;
export interface StudioBlock {
  readonly id: string;
  readonly kind: StudioBlockKind;
  /** Canonical inner HTML of the block (rtr-html-v1 inline content; `<li>`s for lists). */
  readonly value: string;
}

/** known = bindable for this document type · inactive = in the catalog but inactive · unknown = neither. */
export type StudioChipState = 'known' | 'inactive' | 'unknown';
export interface StudioChipInfo {
  readonly state: StudioChipState;
  /** Tooltip: "Label · e.g. sample". */
  readonly title: string;
}
export type StudioChipResolver = (key: string) => StudioChipInfo;

/**
 * TEMPLATE-FIELDS-1 F-7 / F-14 — how an inline Sign field chip looks: its type's glyph and label,
 * its role (or "Sender fills it") and that role's colour index; `locked` on a tenant copy (F-15).
 * Distinct from a variable chip (`{{key}}`): a field is filled by a person when signing.
 */
export interface StudioFieldChipInfo {
  readonly glyph: string;
  readonly label: string;
  readonly role: string;
  /** 0-based colour slot of the role; -1 for a sender-filled field. */
  readonly tone: number;
  readonly locked: boolean;
}
export type StudioFieldChipResolver = (key: string) => StudioFieldChipInfo | null;

// TEMPLATE-CONTENT-2 (C-12) — the Studio writes rtr-html-v2; its kinds come from the shared
// rules (C-0). Text kinds are typed in and converted between; a table, a divider and a page
// break are inserted (and moved, duplicated, deleted) but never converted.
// TEMPLATE-FIELDS-1 F-1 — the current version (rtr-html-v3: v2 plus inline Sign field markers).
export const STUDIO_CONTENT_VERSION = CURRENT_HTML_CONTENT_VERSION;
export const STUDIO_BLOCK_KINDS: readonly StudioBlockKind[] = BLOCK_KINDS_V2;
const NON_TEXT_KINDS: readonly StudioBlockKind[] = ['table', 'hr', 'page_break'];
export const STUDIO_TEXT_KINDS: readonly StudioBlockKind[] = STUDIO_BLOCK_KINDS.filter((k) => !NON_TEXT_KINDS.includes(k));
export function isStudioTextKind(kind: StudioBlockKind): boolean {
  return !NON_TEXT_KINDS.includes(kind);
}
export function isStudioHeadingKind(kind: string): boolean {
  return kind === 'h2' || kind === 'h3' || kind === 'h4';
}

/** The token text a chip shows and the diff / outline plain text carry. */
export function variableToken(key: string): string {
  return `{{${key}}}`;
}

// ── Model ⇄ stored rtr-html-v1 ──────────────────────────────────────────

/**
 * Stored html → Studio content blocks. The html is sanitised to canonical rtr-html-v1 first
 * (never trusted as markup). The tenant-logo letterhead is NOT an editable content block,
 * so this content-only view leaves it out — a host that edits TENANT content must use
 * `studioDocFromHtml` / `studioDocToHtml` (TEMPLATE-STUDIO-1 B-1), which keep it.
 */
export function studioBlocksFromHtml(html: string, newId: () => string): StudioBlock[] {
  return htmlToBlocks(html, STUDIO_CONTENT_VERSION).blocks.map((b) => ({ id: newId(), kind: b.kind, value: b.value }));
}

/** Studio content blocks → stored rtr-html-v1 html (no ids, no letterhead; see studioDocToHtml). */
export function studioBlocksToHtml(blocks: readonly Pick<StudioBlock, 'kind' | 'value'>[]): string {
  return blocksToHtml(false, blocks.map((b) => ({ kind: b.kind, value: b.value })));
}

// ── Letterhead logo (TEMPLATE-STUDIO-1 B-1; DOC-TEMPLATE-ADMIN-RTR-1 A1) ─────────────────
//
// A1 allows exactly one tenant asset in content: `<div data-asset="tenant.logo"></div>`, at
// most once and only as the FIRST child. The version's `logo` reference is SERVER-OWNED (set
// by POST /versions/:id/logo, cleared by DELETE /versions/:id/logo — both place / strip the
// node themselves) and preview/activation fail closed with `logo_asset_mismatch` whenever
// node and reference disagree. The Studio doc model therefore carries the node as one
// NON-EDITABLE letterhead block: decode keeps it, encode writes it back byte-for-byte as
// the first child (exactly once, wherever the block sits), and nothing can place it
// elsewhere. Platform defaults never carry a logo, so their decode/encode is unchanged.
//
// Removal semantics (server stays authoritative): the letterhead is removed ONLY through
// DELETE /versions/:id/logo (reference + node together), after which the host reloads the
// draft. Dropping the block from content while the version still holds a reference is not
// a supported edit: `studioLetterheadState` reports it ('node_missing') so the host can
// block the save, and if such content is saved anyway the server refuses its preview and
// activation (`logo_asset_mismatch`). No server change is needed.

export const STUDIO_LETTERHEAD_KIND = 'letterhead-logo' as const;
/** The stored form of the letterhead block (A1): exactly this, as the first child. */
export const STUDIO_LETTERHEAD_HTML = LOGO_HTML;

/** The non-editable letterhead block (the tenant logo). It carries no value. */
export interface StudioLetterheadBlock {
  readonly id: string;
  readonly kind: typeof STUDIO_LETTERHEAD_KIND;
  readonly value: '';
}
/** One block of a Studio document: editable content, or the tenant letterhead. */
export type StudioDocBlock = StudioBlock | StudioLetterheadBlock;

export function isStudioLetterheadBlock(b: Pick<StudioDocBlock, 'kind'>): b is StudioLetterheadBlock {
  return b.kind === STUDIO_LETTERHEAD_KIND;
}

/**
 * Stored html → Studio document: the letterhead block first (when the stored html has the
 * A1 logo node as its first child), then the content blocks exactly as studioBlocksFromHtml
 * returns them. For content without a logo (every platform default) the result equals
 * studioBlocksFromHtml.
 */
export function studioDocFromHtml(html: string, newId: () => string): StudioDocBlock[] {
  const { logo, blocks } = htmlToBlocks(html, STUDIO_CONTENT_VERSION);
  const content: StudioDocBlock[] = blocks.map((b) => ({ id: newId(), kind: b.kind, value: b.value }));
  return logo ? [{ id: newId(), kind: STUDIO_LETTERHEAD_KIND, value: '' }, ...content] : content;
}

/**
 * Studio document → stored rtr-html-v1 html. A letterhead block (anywhere, any number of
 * times) encodes as ONE `<div data-asset="tenant.logo"></div>` FIRST child (A1); without
 * one the output equals studioBlocksToHtml.
 */
export function studioDocToHtml(blocks: readonly Pick<StudioDocBlock, 'kind' | 'value'>[]): string {
  const content = blocks.filter((b): b is Pick<StudioBlock, 'kind' | 'value'> => !isStudioLetterheadBlock(b));
  return blocksToHtml(studioDocHasLetterhead(blocks), content.map((b) => ({ kind: b.kind, value: b.value })));
}

/** The editable content blocks of a Studio document (the letterhead left out). */
export function studioContentBlocks<B extends Pick<StudioDocBlock, 'kind'>>(blocks: readonly B[]): Exclude<B, StudioLetterheadBlock>[] {
  return blocks.filter((b) => !isStudioLetterheadBlock(b)) as Exclude<B, StudioLetterheadBlock>[];
}

export function studioDocHasLetterhead(blocks: readonly Pick<StudioDocBlock, 'kind'>[]): boolean {
  return blocks.some((b) => isStudioLetterheadBlock(b));
}

/**
 * Letterhead node vs the version's server-owned logo reference — the same rule the server
 * applies at preview/activation (`logo_asset_mismatch`):
 *   ok            — both present or both absent;
 *   node_missing  — the version has a logo but the document has no letterhead block (remove
 *                   it through DELETE /versions/:id/logo, never by editing content);
 *   asset_missing — a letterhead block without a captured logo (capture it through
 *                   POST /versions/:id/logo).
 */
export type StudioLetterheadState = 'ok' | 'node_missing' | 'asset_missing';
export function studioLetterheadState(blocks: readonly Pick<StudioDocBlock, 'kind'>[], logo: { readonly asset_id: string } | null | undefined): StudioLetterheadState {
  const node = studioDocHasLetterhead(blocks);
  const ref = logo !== null && logo !== undefined;
  if (node === ref) return 'ok';
  return ref ? 'node_missing' : 'asset_missing';
}

/** True when the html is already canonical rtr-html-v2 (re-sanitising changes nothing). */
export function isCanonicalStudioHtml(html: string): boolean {
  return sanitizeDocHtml(html, { version: STUDIO_CONTENT_VERSION }) === html;
}

/** Plain text of a block value, chips as `{{key}}`, line breaks and items as spaces. */
export function studioPlainText(value: string): string {
  return studioReadableText(value, (key) => ` ${variableToken(key)} `);
}

/**
 * TEMPLATE-STUDIO-1 (handoff §3 Outline) — human-readable text of a block value: each chip
 * renders through `chip(key)` (the Outline passes the catalog label), line breaks and list
 * items as spaces. PRESENTATION ONLY — reads the value, never rewrites it.
 */
export function studioReadableText(value: string, chip: (key: string) => string): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? '';
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    const key = e.getAttribute('data-field');
    if (key !== null) {
      out += chip(key);
      return;
    }
    if (e.tagName === 'BR') {
      out += ' ';
      return;
    }
    e.childNodes.forEach(walk);
    if (e.tagName === 'LI' || e.tagName === 'TR') out += ' ';
    if (e.tagName === 'TD' || e.tagName === 'TH') out += ' | ';
  };
  parseFragment(value).childNodes.forEach(walk);
  return out.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/(\s*\|\s*)+$/, '').replace(/\s*\|\s*(?=\S)/g, ' | ').trim();
}

/** The text a block shows where text is listed (Outline, version diff, preview estimate). */
export function studioBlockText(b: Pick<StudioBlock, 'kind' | 'value'>): string {
  if (b.kind === 'hr') return '— Divider —';
  if (b.kind === 'page_break') return '— Page break —';
  return studioPlainText(b.value);
}

/** TEMPLATE-FIELDS-1 — every inline Sign field key in a value, in order. */
export function studioFieldKeys(value: string): string[] {
  return Array.from(parseFragment(value).querySelectorAll(`[${SIGN_FIELD_ATTR}]`))
    .map((e) => e.getAttribute(SIGN_FIELD_ATTR) ?? '')
    .filter((k) => k !== '');
}

/** Every variable key used in a value, in order, with repeats (for "N× in draft"). */
export function studioVariableKeys(value: string): string[] {
  return Array.from(parseFragment(value).querySelectorAll('[data-field]'))
    .map((e) => e.getAttribute('data-field') ?? '')
    .filter((k) => k !== '');
}

// ── Typed placeholders (TEMPLATE-CONTENT-2 C-16 … C-18) ───────────────────
//
// `{{key}}` typed as TEXT (not a chip) is never filled in: the server turns a known key into a
// chip on save (C-16) and refuses publishing while any is left (C-17). The Studio reports them
// (readiness, C-18) and converts a known one into a chip.

/** The keys of `{{key}}` text left in a value (chips excluded), in order, with repeats. */
export function studioTypedPlaceholderKeys(value: string): string[] {
  const keys: string[] = [];
  const w = document.createTreeWalker(parseFragment(value), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) keys.push(...placeholderKeysIn(n.textContent ?? ''));
  return keys;
}

/** The value with every `{{key}}` text for `key` turned into a chip (canonicalised). */
export function chipTypedPlaceholder(kind: StudioBlockKind, value: string, key: string): string {
  const frag = parseFragment(value);
  const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const s = t.textContent ?? '';
    if (!placeholderKeysIn(s).includes(key)) continue;
    const parts: Node[] = [];
    let last = 0;
    for (const m of s.matchAll(placeholderTokenRe())) {
      if (m[1] !== key) continue;
      const at = m.index ?? 0;
      if (at > last) parts.push(document.createTextNode(s.slice(last, at)));
      const chip = document.createElement('span');
      chip.setAttribute('data-field', key);
      parts.push(chip);
      last = at + m[0].length;
    }
    if (last < s.length) parts.push(document.createTextNode(s.slice(last)));
    t.replaceWith(...parts);
  }
  const host = document.createElement('div');
  host.appendChild(frag);
  return canonicalInner(kind, host.innerHTML, STUDIO_CONTENT_VERSION);
}

/**
 * C-16 live: when the text just before the caret ends with a typed `{{key}}` (the user typed
 * the closing braces), replace it with a chip. Returns the key, or null when nothing changed
 * (no token there, or `accept` refuses the key — an unknown key stays text for readiness).
 */
export function chipTokenBeforeCaret(range: Range, accept: (key: string) => boolean, chip: (key: string) => Node): string | null {
  const n = range.startContainer;
  if (!range.collapsed || n.nodeType !== Node.TEXT_NODE) return null;
  const before = (n.textContent ?? '').slice(0, range.startOffset);
  const m = new RegExp(`${PLACEHOLDER_TOKEN_SOURCE}$`).exec(before);
  const key = m?.[1];
  if (m === null || key === undefined || !accept(key)) return null;
  const r = document.createRange();
  r.setStart(n, range.startOffset - m[0].length);
  r.setEnd(n, range.startOffset);
  r.deleteContents();
  const c = chip(key);
  r.insertNode(c);
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (sel !== null) {
    const after = document.createRange();
    after.setStartAfter(c);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
  return key;
}

/** True when a block value has no text and no variable. */
export function isStudioValueEmpty(value: string): boolean {
  return isHtmlEmpty(value);
}

/** The value with every chip for `key` removed (canonicalised). */
export function removeStudioVariable(kind: StudioBlockKind, value: string, key: string): string {
  const frag = parseFragment(value);
  frag.querySelectorAll('[data-field]').forEach((e) => {
    if (e.getAttribute('data-field') === key) e.remove();
  });
  const host = document.createElement('div');
  host.appendChild(frag);
  return canonicalInner(kind, host.innerHTML, STUDIO_CONTENT_VERSION);
}

/** The value with a chip for `key` appended (HTML_CODEC's appendField). */
export function appendStudioVariable(kind: StudioBlockKind, value: string, key: string): string {
  if (kind === 'table') {
    // Into the last cell.
    const i = Math.max(value.lastIndexOf('</td>'), value.lastIndexOf('</th>'));
    return i >= 0 ? canonicalInner('table', `${value.slice(0, i)} ${chipHtml(key)}${value.slice(i)}`, STUDIO_CONTENT_VERSION) : value;
  }
  if (kind === 'hr' || kind === 'page_break') return value;
  return HTML_CODEC.appendField(value, kind, key, key);
}

/** Convert a block value between kinds (H / • / 1.), as the RTR editor does. */
export function convertStudioValue(value: string, from: StudioBlockKind, to: StudioBlockKind): string {
  return convertKind(value, from, to);
}

/** `{{key}}` plain text → a canonical block value with chips (paste, clause text). */
export function studioValueFromText(kind: StudioBlockKind, text: string): string {
  const inner = escapeText(text).replace(placeholderTokenRe(), (_w, k: string) => chipHtml(k));
  return canonicalInner(kind, isListKind(kind) ? `<li>${inner}</li>` : inner, STUDIO_CONTENT_VERSION);
}

// ── Preview (server sample html) ─────────────────────────────────────────

/**
 * Split sample-preview html (`<span data-sample>` values) into its top-level blocks, each
 * re-sanitised, so the Studio can lay them out on estimated A4 pages. Each part is still
 * rendered by SafeDoc (the safe allowlist renderer).
 */
export function studioPreviewParts(html: string): { kind: string; html: string; text: string }[] {
  const clean = sanitizeDocHtml(html, { allowSample: true, version: STUDIO_CONTENT_VERSION });
  return Array.from(parseFragment(clean).children)
    .filter((c) => c.getAttribute('data-asset') === null)
    .map((c) => ({
      kind: c.tagName === 'HR' && c.getAttribute(PAGE_BREAK_ATTR) === PAGE_BREAK_VALUE ? 'page_break' : c.tagName.toLowerCase(),
      html: c.outerHTML,
      text: (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
}

// ── Editor DOM (the chip + the codec) ───────────────────────────────────

/** The Studio chip: atomic, mono `{{key}}`, coloured by its state (known / inactive / unknown). */
export function makeStudioChip(key: string, info: StudioChipInfo): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = `pws-chip pws-chip--${info.state}`;
  c.setAttribute('contenteditable', 'false');
  c.setAttribute('data-field', key);
  c.setAttribute('data-state', info.state);
  c.setAttribute('title', info.title);
  c.textContent = variableToken(key);
  return c;
}

/**
 * TEMPLATE-FIELDS-1 F-14 — an inline Sign field chip: atomic, its glyph and label, coloured by its
 * role. It carries data-sign-field (serialised as the marker); a locked chip (a tenant copy,
 * F-15) shows a lock and cannot be opened for editing.
 */
export function makeStudioFieldChip(key: string, info: StudioFieldChipInfo | null): HTMLSpanElement {
  const c = document.createElement('span');
  const tone = info === null ? 'unknown' : info.tone < 0 ? 'sender' : String(info.tone % 6);
  c.className = `pws-fchip pws-fchip--${tone}${info?.locked === true ? ' pws-fchip--locked' : ''}`;
  c.setAttribute('contenteditable', 'false');
  c.setAttribute(SIGN_FIELD_ATTR, key);
  c.setAttribute('data-testid', `field-chip-${key}`);
  c.setAttribute('title', info === null ? `Field ${key}` : `${info.label} · ${info.role}${info.locked ? ' (placed by Aramo)' : ''}`);
  c.textContent = info === null ? `▢ ${key}` : `${info.locked ? '🔒 ' : ''}${info.glyph} ${info.label} · ${info.role}`;
  return c;
}

function textWithChips(text: string, resolve: StudioChipResolver): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(placeholderTokenRe())) {
    const at = m.index ?? 0;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    const key = m[1] ?? '';
    out.push(makeStudioChip(key, resolve(key)));
    last = at + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

// Canonical inline html → editor nodes. Text stays text (no `[Label]` parsing: brackets
// are ordinary characters in the Studio); data-field spans become Studio chips.
function studioEditorNodes(inner: string, resolve: StudioChipResolver, field?: StudioFieldChipResolver): Node[] {
  const conv = (n: Node): Node[] => {
    if (n.nodeType === Node.TEXT_NODE) return [document.createTextNode(n.textContent ?? '')];
    if (n.nodeType !== Node.ELEMENT_NODE) return [];
    const e = n as Element;
    const marker = e.getAttribute(SIGN_FIELD_ATTR);
    if (marker !== null) return isInlineFieldKey(marker) ? [makeStudioFieldChip(marker, field?.(marker) ?? null)] : [];
    const key = e.getAttribute('data-field');
    if (key !== null) return KEY_RE.test(key) ? [makeStudioChip(key, resolve(key))] : [];
    const c = document.createElement(e.tagName.toLowerCase());
    e.childNodes.forEach((ch) => conv(ch).forEach((x) => c.appendChild(x)));
    return [c];
  };
  const out: Node[] = [];
  parseFragment(inner).childNodes.forEach((n) => conv(n).forEach((x) => out.push(x)));
  return out;
}

function isListKind(kind: StudioBlockKind): boolean {
  return kind === 'ul' || kind === 'ol';
}

// ── Tables (TEMPLATE-CONTENT-2 C-13) ─────────────────────────────────────
//
// A table block's value is its canonical rows: `<tr><th>…</th></tr><tr><td>…</td></tr>`. The
// editor draws a real <table> whose cells each hold ONE editable region (`[data-cell="r:c"]`,
// a labelled textbox) — the table's structure is never editable as text, so typing can't
// break it; rows, columns and the header row change only through the table controls.

export interface StudioTable {
  /** The first row is a header row (th cells). */
  readonly header: boolean;
  /** Cell inner HTML (inline content), row by row; every row has the same length. */
  readonly rows: readonly (readonly string[])[];
}

export function parseStudioTable(value: string): StudioTable {
  const t = parseFragment(`<table>${value}</table>`).firstElementChild;
  const trs = t === null ? [] : Array.from(t.querySelectorAll('tr'));
  const rows = trs.map((tr) => Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH'));
  const header = rows.length > 0 && (rows[0] as Element[]).length > 0 && (rows[0] as Element[]).every((c) => c.tagName === 'TH');
  const width = Math.max(1, ...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: width }, (_x, i) => r[i]?.innerHTML ?? ''));
  return { header, rows: grid.length > 0 ? grid : [Array.from({ length: width }, () => '')] };
}

export function studioTableValue(t: StudioTable): string {
  return canonicalInner(
    'table',
    t.rows.map((r, ri) => `<tr>${r.map((c) => (t.header && ri === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join(''),
    STUDIO_CONTENT_VERSION,
  );
}

export function makeStudioTable(rows: number, cols: number, header = true): StudioTable {
  return { header, rows: Array.from({ length: Math.max(1, rows) }, () => Array.from({ length: Math.max(1, cols) }, () => '')) };
}

function cellLabel(header: boolean, r: number, c: number): string {
  if (header && r === 0) return `Header, column ${c + 1}`;
  return `Row ${header ? r : r + 1}, column ${c + 1}`;
}

function renderStudioTableDom(el: HTMLElement, value: string, resolve: StudioChipResolver, field?: StudioFieldChipResolver): void {
  const t = parseStudioTable(value);
  const table = el.appendChild(document.createElement('table'));
  table.className = 'pws-tbl';
  const body = table.appendChild(document.createElement('tbody'));
  t.rows.forEach((row, r) => {
    const tr = body.appendChild(document.createElement('tr'));
    row.forEach((cell, c) => {
      const td = tr.appendChild(document.createElement(t.header && r === 0 ? 'th' : 'td'));
      const ed = td.appendChild(document.createElement('div'));
      ed.className = 'pws-tbl__cell';
      ed.setAttribute('contenteditable', 'true');
      ed.setAttribute('role', 'textbox');
      ed.setAttribute('aria-label', cellLabel(t.header, r, c));
      ed.setAttribute('data-cell', `${r}:${c}`);
      studioEditorNodes(cell, resolve, field).forEach((n) => ed.appendChild(n));
    });
  });
}

function serializeStudioTableDom(el: Node): string {
  const host = el as Element;
  const rows = Array.from(host.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('[data-cell]')).map((cell) => ({
      th: cell.parentElement?.tagName === 'TH',
      inner: serializeInlineHtml(cell, NO_BINDINGS),
    })),
  );
  return canonicalInner('table', rows.map((r) => `<tr>${r.map((c) => (c.th ? `<th>${c.inner}</th>` : `<td>${c.inner}</td>`)).join('')}</tr>`).join(''), STUDIO_CONTENT_VERSION);
}

// ── Lists two levels deep (C-14) ─────────────────────────────────────────

function isListEl(n: Node): n is Element {
  return n.nodeType === Node.ELEMENT_NODE && ((n as Element).tagName === 'UL' || (n as Element).tagName === 'OL');
}

// A list host → its `<li>` items, a nested list kept inside its item. Depth is clamped by the
// canonical form (sanitizeDocHtml v2 lifts a third level into the second).
function serializeStudioList(host: Node): string {
  let items = '';
  host.childNodes.forEach((c) => {
    if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName === 'LI') {
      const inline = document.createElement('span');
      let sub = '';
      c.childNodes.forEach((x) => {
        if (isListEl(x)) sub += `<${x.tagName.toLowerCase()}>${serializeStudioList(x)}</${x.tagName.toLowerCase()}>`;
        else inline.appendChild(x.cloneNode(true));
      });
      items += `<li>${serializeInlineHtml(inline, NO_BINDINGS)}${sub}</li>`;
      return;
    }
    if (isListEl(c)) {
      // A list directly inside a list (some browsers indent that way) → into the item above.
      const nested = `<${c.tagName.toLowerCase()}>${serializeStudioList(c)}</${c.tagName.toLowerCase()}>`;
      items = items.endsWith('</li>') ? `${items.slice(0, -5)}${nested}</li>` : `${items}<li>${nested}</li>`;
      return;
    }
    const tmp = document.createElement('span');
    tmp.appendChild(c.cloneNode(true));
    const s = serializeInlineHtml(tmp, NO_BINDINGS);
    if (s.trim() !== '') items += `<li>${s}</li>`;
  });
  return items;
}

const NO_BINDINGS = { labelByToken: {}, tokenByLabel: {} };

/** How deep a list item sits inside `root` (1 = a top-level item). */
export function studioListDepth(li: Element, root: Element): number {
  let d = 0;
  for (let n: Element | null = li.parentElement; n !== null && n !== root.parentElement; n = n.parentElement) if (isListEl(n)) d += 1;
  return d;
}

/**
 * Indent a list item (Tab): it moves into a list inside the item above it. Refused when there
 * is no item above ('no_prev') or it would go deeper than the allowed levels ('too_deep').
 */
export function indentStudioListItem(li: HTMLElement, root: HTMLElement): 'ok' | 'no_prev' | 'too_deep' {
  if (studioListDepth(li, root) >= LIST_MAX_DEPTH_V2) return 'too_deep';
  // The item's own sub-items would end up a level too deep: refuse rather than reshuffle them.
  if (Array.from(li.children).some((c) => isListEl(c))) return 'too_deep';
  const prev = li.previousElementSibling;
  if (prev === null || prev.tagName !== 'LI') return 'no_prev';
  const parentTag = li.parentElement?.tagName.toLowerCase() ?? 'ul';
  let sub = Array.from(prev.children).reverse().find((c) => isListEl(c)) ?? null;
  if (sub === null) sub = prev.appendChild(document.createElement(parentTag));
  sub.appendChild(li);
  return 'ok';
}

/**
 * Outdent a list item (Shift+Tab): it moves out to the level above, right after its parent
 * item; the items below it come along as its own sub-items. False at the top level.
 */
export function outdentStudioListItem(li: HTMLElement): boolean {
  const list = li.parentElement;
  const parentLi = list?.parentElement ?? null;
  if (list === null || parentLi === null || parentLi.tagName !== 'LI') return false;
  const after: Element[] = [];
  for (let n = li.nextElementSibling; n !== null; n = n.nextElementSibling) after.push(n);
  if (after.length > 0) {
    const sub = li.appendChild(document.createElement(list.tagName.toLowerCase()));
    after.forEach((n) => sub.appendChild(n));
  }
  parentLi.after(li);
  if (list.children.length === 0) list.remove();
  return true;
}

/** Render a block value into its editable element (lists get their `<ul>/<ol>` host). */
export function renderStudioBlockDom(el: HTMLElement, value: string, kind: StudioBlockKind, resolve: StudioChipResolver, field?: StudioFieldChipResolver): void {
  while (el.firstChild !== null) el.removeChild(el.firstChild);
  el.setAttribute('data-kind', kind);
  if (kind === 'table') {
    renderStudioTableDom(el, value, resolve, field);
    return;
  }
  if (kind === 'hr') {
    el.appendChild(document.createElement('hr')).className = 'pws-hr';
    return;
  }
  if (kind === 'page_break') {
    const m = el.appendChild(document.createElement('div'));
    m.className = 'pws-pb';
    m.appendChild(document.createElement('span')).textContent = 'Page break';
    return;
  }
  const host: Element = isListKind(kind) ? el.appendChild(document.createElement(kind)) : el;
  studioEditorNodes(value, resolve, field).forEach((n) => host.appendChild(n));
  if (isListKind(kind) && host.childNodes.length === 0) host.appendChild(document.createElement('li'));
}

/**
 * TEMPLATE-FIELDS-1 F-14 — moving a field chip (cut, then paste): when the clipboard html holds
 * field chips, the paste rebuilds them (only keys `acceptField` allows: the document's own fields
 * that are not in the text any more), with the plain text around them. Otherwise null.
 */
function pastedWithFieldChips(html: string, resolve: StudioChipResolver, field: StudioFieldChipResolver | undefined, acceptField: (key: string) => boolean): Node[] | null {
  if (!html.includes(SIGN_FIELD_ATTR)) return null;
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      textWithChips((n.textContent ?? '').replace(/[\r\n\t]+/g, ' '), resolve).forEach((x) => out.push(x));
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    const marker = e.getAttribute(SIGN_FIELD_ATTR);
    if (marker !== null) {
      if (isInlineFieldKey(marker) && acceptField(marker)) out.push(makeStudioFieldChip(marker, field?.(marker) ?? null));
      return;
    }
    const variable = e.getAttribute('data-field');
    if (variable !== null) {
      if (KEY_RE.test(variable)) out.push(makeStudioChip(variable, resolve(variable)));
      return;
    }
    if (e.tagName === 'BR') {
      out.push(document.createElement('br'));
      return;
    }
    e.childNodes.forEach(walk);
  };
  parseFragment(html).childNodes.forEach(walk);
  return out;
}

/** Pasted clipboard → plain text with `{{key}}` tokens as chips and line breaks as `<br>`. */
export function studioPasteNodes(data: DataTransfer | null, resolve: StudioChipResolver, field?: StudioFieldChipResolver, acceptField: (key: string) => boolean = () => false): Node[] {
  const moved = pastedWithFieldChips(data?.getData('text/html') ?? '', resolve, field, acceptField);
  if (moved !== null) return moved;
  const plain = (data?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
  if (plain === '') return [];
  const out: Node[] = [];
  plain.split('\n').forEach((line, i) => {
    if (i > 0) out.push(document.createElement('br'));
    textWithChips(line.replace(/\t/g, ' '), resolve).forEach((n) => out.push(n));
  });
  return out;
}

/**
 * The Studio BlockCodec: HTML_CODEC (rtr-html-v1) with the Studio's chip renderer. Storage,
 * serialisation, kind conversion, emptiness and scanning are HTML_CODEC's own functions.
 */
export function createStudioCodec(resolve: StudioChipResolver, field?: StudioFieldChipResolver, acceptField?: (key: string) => boolean): BlockCodec {
  return {
    ...HTML_CODEC,
    render: (el: HTMLElement, value: string, _map: BindingMap, kind: BlockKind) => renderStudioBlockDom(el, value, kind, resolve, field),
    serialize: (el: Node, _map: BindingMap, kind: BlockKind) => serializeStudioBlockDom(el, kind),
    convert: convertStudioValue,
    appendField: (value: string, kind: BlockKind, key: string) => appendStudioVariable(kind, value, key),
    needsNormalize: () => false,
    pasteNodes: (data: DataTransfer | null) => studioPasteNodes(data, resolve, field, acceptField),
  };
}

/**
 * Serialise an editable element back to its canonical block value: HTML_CODEC.serialize for
 * paragraphs and headings; the v2 forms for lists (two levels), tables, dividers, page breaks.
 */
export function serializeStudioBlockDom(el: Node, kind: StudioBlockKind): string {
  if (kind === 'hr' || kind === 'page_break') return '';
  if (kind === 'table') return serializeStudioTableDom(el);
  if (isListKind(kind)) {
    const host = Array.from((el as Element).children ?? []).find((c) => isListEl(c)) ?? el;
    return canonicalInner(kind, serializeStudioList(host), STUDIO_CONTENT_VERSION);
  }
  // TEMPLATE-FIELDS-1 — paragraphs and headings canonicalise in the Studio's version (v3), so a
  // paragraph keeps its field markers (a heading never does: the shared rule, F-2).
  return canonicalInner(kind, serializeInlineHtml(el, NO_BINDINGS), STUDIO_CONTENT_VERSION);
}

// Range-based editing helpers re-exported for the Studio canvas (no document.execCommand).
export { activeMarks as studioActiveMarks, toggleMark as studioToggleMark, insertAtRange as studioInsertAtRange };
