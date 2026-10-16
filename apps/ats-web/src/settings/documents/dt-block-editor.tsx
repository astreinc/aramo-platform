import { useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';

import { parseLabelSegments, sourceOf, tokensToLabels, SOURCE_PATH, type BindingMap } from './dt-ui';
import {
  canonicalInner,
  chipHtml,
  convertKind,
  escapeText,
  isHtmlEmpty,
  parseFragment,
  sanitizePastedInline,
  scanHtml,
  type BlockKind,
} from './dt-html';

// DOC-TEMPLATE-ADMIN-RTR-1 (§9.1 + Amendment A1) — one editable content block of the RTR
// draft. A contentEditable box whose governed fields are ATOMIC chips:
//   <span contenteditable="false" data-field="{key}">icon · label · ×</span>
// ALL content-model knowledge lives in a BlockCodec, so the UI is identical for both models:
//  - TEXT_TOKEN_CODEC (rtr-generated-v1): plain text with [Label] fields ({{token}} on save).
//  - HTML_CODEC       (rtr-html-v1):      allowlisted inline HTML (b/i/u/br + chips; li for lists).
// Unknown fields render as a red "unknown field" chip (they block approval).
//
// The DOM is owned by the browser while typing (so the caret never jumps); React only
// re-renders it when the block value or kind changes from OUTSIDE (insert, clause, toggle,
// reorder…) — detected by comparing the serialised DOM with the block value.

const SVG_NS = 'http://www.w3.org/2000/svg';

function chipIcon(key: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'dt-chip__ic');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', SOURCE_PATH[sourceOf(key)]);
  svg.appendChild(path);
  return svg;
}

function removeX(label: string): HTMLSpanElement {
  const x = document.createElement('span');
  x.className = 'dt-chip__x';
  x.setAttribute('role', 'button');
  x.setAttribute('aria-label', `Remove ${label}`);
  x.setAttribute('title', `Remove ${label}`);
  x.setAttribute('data-chip-remove', '');
  x.textContent = '×';
  return x;
}

// A governed field chip (atomic, removable).
export function makeFieldChip(key: string, label: string): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = 'dt-chip dt-chip--ed';
  c.setAttribute('contenteditable', 'false');
  c.setAttribute('data-field', key);
  c.appendChild(chipIcon(key));
  const l = document.createElement('span');
  l.textContent = label;
  c.appendChild(l);
  c.appendChild(removeX(label));
  return c;
}

// An unknown field chip — red, removable, blocks approval. `attr` keeps what it stands for:
// data-bad = a typed [name] (serialises back as text); data-bad-field = an unknown key.
function makeBadChip(text: string, attr: 'data-bad' | 'data-bad-field'): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = 'dt-chip dt-chip--ed dt-chip--bad';
  c.setAttribute('contenteditable', 'false');
  c.setAttribute(attr, text);
  c.setAttribute('title', 'Not a governed field — remove it or insert a field from the list');
  const l = document.createElement('span');
  l.textContent = `${text} · unknown field`;
  c.appendChild(l);
  c.appendChild(removeX(text));
  return c;
}

// ── v1 plain-text codec helpers ─────────────────────────────────────────
export function renderBlockDom(el: HTMLElement, text: string, map: BindingMap): void {
  while (el.firstChild != null) el.removeChild(el.firstChild);
  for (const s of parseLabelSegments(text, map)) {
    if (s.kind === 'text') el.appendChild(document.createTextNode(s.t));
    else if (s.kind === 'field') el.appendChild(makeFieldChip(map.tokenByLabel[s.t] ?? s.t, s.t));
    else el.appendChild(makeBadChip(s.t, 'data-bad'));
  }
}

// DOM → editable [Label] text. Plain text only: chips become [Label]; any other element
// (pasted/browser markup) contributes only its text; line breaks collapse to spaces.
export function serializeBlockDom(el: Node, map: BindingMap): string {
  let out = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { out += (n.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' '); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as HTMLElement;
    const key = e.getAttribute('data-field');
    if (key != null) { out += `[${map.labelByToken[key] ?? key}]`; return; }
    const bad = e.getAttribute('data-bad') ?? e.getAttribute('data-bad-field');
    if (bad != null) { out += `[${bad}]`; return; }
    if (e.tagName === 'BR') { out += ' '; return; }
    out += serializeBlockDom(e, map);
  });
  return out;
}

// True when typed text still contains a bracketed name that should become a chip.
function hasRawBrackets(el: HTMLElement): boolean {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n != null; n = w.nextNode()) {
    if (/\[[^\]]+\]/.test(n.textContent ?? '') && n.parentElement?.closest('[data-field],[data-bad],[data-bad-field]') == null) return true;
  }
  return false;
}

// ── rtr-html-v1 codec helpers ───────────────────────────────────────────
// Canonical inline HTML → editor nodes (chips expanded; [Label] text → chips).
function toEditorNodes(inner: string, map: BindingMap): Node[] {
  const out: Node[] = [];
  const conv = (n: Node): Node[] => {
    if (n.nodeType === Node.TEXT_NODE) {
      const res: Node[] = [];
      for (const s of parseLabelSegments(n.textContent ?? '', map)) {
        if (s.kind === 'text') res.push(document.createTextNode(s.t));
        else if (s.kind === 'field') res.push(makeFieldChip(map.tokenByLabel[s.t] ?? s.t, s.t));
        else res.push(makeBadChip(s.t, 'data-bad'));
      }
      return res;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return [];
    const e = n as Element;
    const key = e.getAttribute('data-field');
    if (key != null) {
      const label = map.labelByToken[key];
      return [label != null ? makeFieldChip(key, label) : makeBadChip(key, 'data-bad-field')];
    }
    const c = document.createElement(e.tagName.toLowerCase());
    e.childNodes.forEach((ch) => conv(ch).forEach((x) => c.appendChild(x)));
    return [c];
  };
  parseFragment(inner).childNodes.forEach((n) => conv(n).forEach((x) => out.push(x)));
  return out;
}

function isList(kind: BlockKind): boolean { return kind === 'ul' || kind === 'ol'; }

function renderHtmlDom(el: HTMLElement, value: string, map: BindingMap, kind: BlockKind): void {
  while (el.firstChild != null) el.removeChild(el.firstChild);
  el.setAttribute('data-kind', kind);
  const host: Element = isList(kind) ? el.appendChild(document.createElement(kind)) : el;
  toEditorNodes(value, map).forEach((n) => host.appendChild(n));
  if (isList(kind) && host.childNodes.length === 0) host.appendChild(document.createElement('li'));
}

function serializeInlineHtml(n: Node, map: BindingMap): string {
  let out = '';
  n.childNodes.forEach((c) => {
    if (c.nodeType === Node.TEXT_NODE) { out += escapeText((c.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ')); return; }
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    const e = c as Element;
    const key = e.getAttribute('data-field') ?? e.getAttribute('data-bad-field');
    if (key != null) { out += chipHtml(key); return; }
    const bad = e.getAttribute('data-bad');
    if (bad != null) { out += escapeText(`[${bad}]`); return; }
    const tag = e.tagName;
    if (tag === 'BR') { out += '<br>'; return; }
    const inner = serializeInlineHtml(e, map);
    if (tag === 'B' || tag === 'STRONG') { out += `<b>${inner}</b>`; return; }
    if (tag === 'I' || tag === 'EM') { out += `<i>${inner}</i>`; return; }
    if (tag === 'U') { out += `<u>${inner}</u>`; return; }
    // Browser-created wrappers (div/p on Enter, styled spans) → unwrap, keep line breaks.
    out += inner;
    if ((tag === 'DIV' || tag === 'P') && c.nextSibling != null) out += '<br>';
  });
  return out;
}

function serializeHtmlDom(el: Node, map: BindingMap, kind: BlockKind): string {
  if (!isList(kind)) return canonicalInner(kind, serializeInlineHtml(el, map));
  const host = (el as Element).querySelector?.(kind) ?? el;
  let items = '';
  host.childNodes.forEach((c) => {
    if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName === 'LI') { items += `<li>${serializeInlineHtml(c, map)}</li>`; return; }
    const tmp = document.createElement('span');
    tmp.appendChild(c.cloneNode(true));
    const s = serializeInlineHtml(tmp, map);
    if (s.trim() !== '') items += `<li>${s}</li>`;
  });
  return canonicalInner(kind, items);
}

// ── The codec seam ──────────────────────────────────────────────────────
export interface BlockCodec {
  readonly id: 'text-v1' | 'html-v1';
  // Inline marks (B/I/U), lists (•/1.) and the tenant-logo letterhead persist only in HTML.
  readonly rich: boolean;
  readonly render: (el: HTMLElement, value: string, map: BindingMap, kind: BlockKind) => void;
  readonly serialize: (el: Node, map: BindingMap, kind: BlockKind) => string;
  readonly needsNormalize: (el: HTMLElement) => boolean;
  readonly convert: (value: string, from: BlockKind, to: BlockKind) => string;
  readonly isEmpty: (value: string) => boolean;
  readonly scan: (value: string, map: BindingMap) => { used: string[]; bad: string[] };
  readonly appendField: (value: string, kind: BlockKind, key: string, label: string) => string;
  readonly fieldBlock: (key: string, label: string) => string; // a block that is just one field
  readonly fromTemplate: (textWithTokens: string, map: BindingMap) => string; // clause text
  readonly pasteNodes: (data: DataTransfer | null, map: BindingMap) => Node[];
}

export const TEXT_TOKEN_CODEC: BlockCodec = {
  id: 'text-v1',
  rich: false,
  render: (el, value, map) => renderBlockDom(el, value, map),
  serialize: (el, map) => serializeBlockDom(el, map),
  needsNormalize: (el) => hasRawBrackets(el),
  convert: (value) => value,
  isEmpty: (value) => value.trim() === '',
  scan: (value, map) => {
    const used: string[] = [];
    const bad: string[] = [];
    for (const s of parseLabelSegments(value, map)) {
      if (s.kind === 'field') { const k = map.tokenByLabel[s.t]; if (k != null && !used.includes(k)) used.push(k); }
      if (s.kind === 'bad' && !bad.includes(s.t)) bad.push(s.t);
    }
    return { used, bad };
  },
  appendField: (value, _kind, _key, label) => `${value}${value !== '' && !/\s$/.test(value) ? ' ' : ''}[${label}]`,
  fieldBlock: (_key, label) => `[${label}]`,
  fromTemplate: (text, map) => tokensToLabels(text, map),
  pasteNodes: (data) => {
    const plain = (data?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ');
    return plain === '' ? [] : [document.createTextNode(plain)];
  },
};

export const HTML_CODEC: BlockCodec = {
  id: 'html-v1',
  rich: true,
  render: renderHtmlDom,
  serialize: serializeHtmlDom,
  needsNormalize: (el) => hasRawBrackets(el),
  convert: convertKind,
  isEmpty: isHtmlEmpty,
  scan: (value, map) => scanHtml(value, map.tokenByLabel, (k) => map.labelByToken[k] != null),
  appendField: (value, kind, key) => {
    if (isList(kind)) {
      const i = value.lastIndexOf('</li>');
      const v = i >= 0 ? `${value.slice(0, i)} ${chipHtml(key)}${value.slice(i)}` : `<li>${chipHtml(key)}</li>`;
      return canonicalInner(kind, v);
    }
    return canonicalInner(kind, value === '' ? chipHtml(key) : `${value} ${chipHtml(key)}`);
  },
  fieldBlock: (key) => chipHtml(key),
  fromTemplate: (text) => canonicalInner('p', escapeText(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_w, k: string) => chipHtml(k))),
  pasteNodes: (data, map) => {
    const html = data?.getData('text/html') ?? '';
    if (html.trim() !== '') return toEditorNodes(sanitizePastedInline(html), map);
    const plain = (data?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ');
    return plain === '' ? [] : [document.createTextNode(plain)];
  },
};

// Insert nodes at a range (or at the end of el) and place the caret after them.
export function insertAtRange(el: HTMLElement, range: Range | null, nodes: readonly Node[]): void {
  const r = range != null && el.contains(range.startContainer) ? range : null;
  if (r == null) {
    const host = el.querySelector('li:last-child') ?? el;
    for (const n of nodes) host.appendChild(n);
    return;
  }
  r.deleteContents();
  for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; if (n != null) r.insertNode(n); }
  const last = nodes[nodes.length - 1];
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (sel != null && last != null) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

export function BlockBox({
  blockId,
  value,
  kind,
  map,
  placeholder,
  testId,
  registerEl,
  onChange,
  onSelect,
  onEnter,
  codec = TEXT_TOKEN_CODEC,
}: {
  readonly blockId: string;
  readonly value: string;
  readonly kind: BlockKind;
  readonly map: BindingMap;
  readonly placeholder: string;
  readonly testId: string;
  readonly registerEl: (id: string, el: HTMLDivElement | null) => void;
  readonly onChange: (id: string, value: string) => void;
  readonly onSelect: (id: string, range: Range | null) => void;
  readonly onEnter: (id: string) => void;
  readonly codec?: BlockCodec;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastKind = useRef<BlockKind | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return;
    if (lastKind.current !== kind || codec.serialize(el, map, kind) !== value) {
      codec.render(el, value, map, kind);
      lastKind.current = kind;
    }
  }, [value, kind, map, codec]);

  function sync() { const el = ref.current; if (el != null) onChange(blockId, codec.serialize(el, map, kind)); }
  function saveSel() {
    const el = ref.current;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (el != null && sel != null && sel.rangeCount > 0 && el.contains(sel.anchorNode)) onSelect(blockId, sel.getRangeAt(0).cloneRange());
    else onSelect(blockId, null);
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter') return;
    if (codec.rich && isList(kind)) return; // browser default: a new list item
    e.preventDefault();
    const el = ref.current;
    if (codec.rich && e.shiftKey && el != null) {
      const sel = window.getSelection();
      insertAtRange(el, sel != null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null, [document.createElement('br')]);
      sync();
      return;
    }
    onEnter(blockId);
  }
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = ref.current;
    if (el == null) return;
    const nodes = codec.pasteNodes(e.clipboardData ?? null, map);
    if (nodes.length === 0) return;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    insertAtRange(el, sel != null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null, nodes);
    sync();
  }
  function onClick(e: MouseEvent<HTMLDivElement>) {
    const x = (e.target as HTMLElement).closest('[data-chip-remove]');
    if (x == null) return;
    e.preventDefault();
    x.parentElement?.remove();
    sync();
  }
  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('[data-chip-remove]') != null) e.preventDefault();
  }
  // Rich drops (HTML from another page) are refused — paste is the sanitised path.
  function onDrop(e: DragEvent<HTMLDivElement>) {
    const types = Array.from(e.dataTransfer?.types ?? []);
    if (types.includes('application/x-aramo-block')) return; // a block reorder — the row handles it
    e.preventDefault();
  }

  return (
    <div
      ref={(el) => { ref.current = el; registerEl(blockId, el); }}
      className={`dt-blk dt-blk--${kind}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={codec.rich ? 'true' : 'false'}
      aria-label={placeholder}
      tabIndex={0}
      spellCheck
      data-placeholder={placeholder}
      data-testid={testId}
      onInput={() => { sync(); saveSel(); }}
      onBlur={() => {
        const el = ref.current;
        if (el == null) return;
        const v = codec.serialize(el, map, kind);
        if (codec.needsNormalize(el)) codec.render(el, v, map, kind);
        onChange(blockId, v);
      }}
      onFocus={saveSel}
      onKeyUp={saveSel}
      onMouseUp={saveSel}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDrop={onDrop}
    />
  );
}
