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

import { HTML_CODEC, insertAtRange, type BlockCodec } from './dt-block-editor';
import {
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

const TOKEN_SPLIT = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const KEY_RE = /^[A-Za-z0-9_.]+$/;

/** The token text a chip shows and the diff / outline plain text carry. */
export function variableToken(key: string): string {
  return `{{${key}}}`;
}

// ── Model ⇄ stored rtr-html-v1 ──────────────────────────────────────────

/**
 * Stored html → Studio blocks. The html is sanitised to canonical rtr-html-v1 first (never
 * trusted as markup). A tenant-logo div is not Studio content (platform defaults carry no
 * tenant asset) and is dropped.
 */
export function studioBlocksFromHtml(html: string, newId: () => string): StudioBlock[] {
  return htmlToBlocks(html).blocks.map((b) => ({ id: newId(), kind: b.kind, value: b.value }));
}

/** Studio blocks → stored rtr-html-v1 html (no ids, no logo). */
export function studioBlocksToHtml(blocks: readonly Pick<StudioBlock, 'kind' | 'value'>[]): string {
  return blocksToHtml(false, blocks.map((b) => ({ kind: b.kind, value: b.value })));
}

/** True when the html is already canonical rtr-html-v1 (re-sanitising changes nothing). */
export function isCanonicalStudioHtml(html: string): boolean {
  return sanitizeDocHtml(html) === html;
}

/** Plain text of a block value, chips as `{{key}}`, line breaks and items as spaces. */
export function studioPlainText(value: string): string {
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
      out += ` ${variableToken(key)} `;
      return;
    }
    if (e.tagName === 'BR') {
      out += ' ';
      return;
    }
    e.childNodes.forEach(walk);
    if (e.tagName === 'LI') out += ' ';
  };
  parseFragment(value).childNodes.forEach(walk);
  return out.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every variable key used in a value, in order, with repeats (for "N× in draft"). */
export function studioVariableKeys(value: string): string[] {
  return Array.from(parseFragment(value).querySelectorAll('[data-field]'))
    .map((e) => e.getAttribute('data-field') ?? '')
    .filter((k) => k !== '');
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
  return canonicalInner(kind, host.innerHTML);
}

/** The value with a chip for `key` appended (HTML_CODEC's appendField). */
export function appendStudioVariable(kind: StudioBlockKind, value: string, key: string): string {
  return HTML_CODEC.appendField(value, kind, key, key);
}

/** Convert a block value between kinds (H / • / 1.), as the RTR editor does. */
export function convertStudioValue(value: string, from: StudioBlockKind, to: StudioBlockKind): string {
  return convertKind(value, from, to);
}

/** `{{key}}` plain text → a canonical block value with chips (paste, clause text). */
export function studioValueFromText(kind: StudioBlockKind, text: string): string {
  const inner = escapeText(text).replace(TOKEN_SPLIT, (_w, k: string) => chipHtml(k));
  return canonicalInner(kind, kind === 'ul' || kind === 'ol' ? `<li>${inner}</li>` : inner);
}

// ── Preview (server sample html) ─────────────────────────────────────────

/**
 * Split sample-preview html (`<span data-sample>` values) into its top-level blocks, each
 * re-sanitised, so the Studio can lay them out on estimated A4 pages. Each part is still
 * rendered by SafeDoc (the safe allowlist renderer).
 */
export function studioPreviewParts(html: string): { kind: string; html: string; text: string }[] {
  const clean = sanitizeDocHtml(html, { allowSample: true });
  return Array.from(parseFragment(clean).children)
    .filter((c) => c.getAttribute('data-asset') === null)
    .map((c) => ({ kind: c.tagName.toLowerCase(), html: c.outerHTML, text: (c.textContent ?? '').replace(/\s+/g, ' ').trim() }));
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

function textWithChips(text: string, resolve: StudioChipResolver): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_SPLIT)) {
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
function studioEditorNodes(inner: string, resolve: StudioChipResolver): Node[] {
  const conv = (n: Node): Node[] => {
    if (n.nodeType === Node.TEXT_NODE) return [document.createTextNode(n.textContent ?? '')];
    if (n.nodeType !== Node.ELEMENT_NODE) return [];
    const e = n as Element;
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

/** Render a block value into its editable element (lists get their `<ul>/<ol>` host). */
export function renderStudioBlockDom(el: HTMLElement, value: string, kind: StudioBlockKind, resolve: StudioChipResolver): void {
  while (el.firstChild !== null) el.removeChild(el.firstChild);
  el.setAttribute('data-kind', kind);
  const host: Element = isListKind(kind) ? el.appendChild(document.createElement(kind)) : el;
  studioEditorNodes(value, resolve).forEach((n) => host.appendChild(n));
  if (isListKind(kind) && host.childNodes.length === 0) host.appendChild(document.createElement('li'));
}

/** Pasted clipboard → plain text with `{{key}}` tokens as chips and line breaks as `<br>`. */
export function studioPasteNodes(data: DataTransfer | null, resolve: StudioChipResolver): Node[] {
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
export function createStudioCodec(resolve: StudioChipResolver): BlockCodec {
  return {
    ...HTML_CODEC,
    render: (el: HTMLElement, value: string, _map: BindingMap, kind: BlockKind) => renderStudioBlockDom(el, value, kind, resolve),
    needsNormalize: () => false,
    pasteNodes: (data: DataTransfer | null) => studioPasteNodes(data, resolve),
  };
}

/** Serialise an editable element back to its canonical block value (HTML_CODEC.serialize). */
export function serializeStudioBlockDom(el: Node, kind: StudioBlockKind): string {
  return HTML_CODEC.serialize(el, { labelByToken: {}, tokenByLabel: {} }, kind);
}

// Range-based editing helpers re-exported for the Studio canvas (no document.execCommand).
export { activeMarks as studioActiveMarks, toggleMark as studioToggleMark, insertAtRange as studioInsertAtRange };
