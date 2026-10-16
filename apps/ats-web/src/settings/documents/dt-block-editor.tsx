import { useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';

import { parseLabelSegments, sourceOf, SOURCE_PATH, type BindingMap } from './dt-ui';

// DOC-TEMPLATE-ADMIN-RTR-1 (§9.1) — one editable content block of the RTR draft.
// A contentEditable box whose governed fields are ATOMIC chips:
//   <span contenteditable="false" data-field="{token}">icon · label · ×</span>
// The box holds PLAIN TEXT only (paste inserts text/plain; any other markup is dropped on
// serialisation). It is serialised back to the editor's [Label] text form, which
// buildFieldSchema turns into {{token}} placeholders on save. An unknown [name] or
// unknown {{token}} renders as a red "unknown field" chip (it blocks approval).
//
// The DOM is owned by the browser while typing (so the caret never jumps); React only
// re-renders it when the block text changes from OUTSIDE (insert, clause, reorder…) —
// detected by comparing the serialised DOM with the block text.

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

// An unknown (non-governed) field chip — red, removable, blocks approval.
function makeBadChip(text: string): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = 'dt-chip dt-chip--ed dt-chip--bad';
  c.setAttribute('contenteditable', 'false');
  c.setAttribute('data-bad', text);
  c.setAttribute('title', 'Not a governed field — remove it or insert a field from the list');
  const l = document.createElement('span');
  l.textContent = `${text} · unknown field`;
  c.appendChild(l);
  c.appendChild(removeX(text));
  return c;
}

export function renderBlockDom(el: HTMLElement, text: string, map: BindingMap): void {
  while (el.firstChild != null) el.removeChild(el.firstChild);
  for (const s of parseLabelSegments(text, map)) {
    if (s.kind === 'text') el.appendChild(document.createTextNode(s.t));
    else if (s.kind === 'field') el.appendChild(makeFieldChip(map.tokenByLabel[s.t] ?? s.t, s.t));
    else el.appendChild(makeBadChip(s.t));
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
    const bad = e.getAttribute('data-bad');
    if (bad != null) { out += `[${bad}]`; return; }
    if (e.tagName === 'BR') { out += ' '; return; }
    out += serializeBlockDom(e, map);
  });
  return out;
}

// Amendment A1 (rtr-html-v1, allowlisted HTML) seam: ALL content-model knowledge of the
// box lives in a codec — render a stored block value into the box, and serialise the box
// back. Today's codec is the v1 [Label]/{{token}} plain-text model; the HTML codec
// (p/h2/b/i/u/ul/ol/li/br + data-field chips) slots in here without touching the UI.
export interface BlockCodec {
  readonly render: (el: HTMLElement, value: string, map: BindingMap) => void;
  readonly serialize: (el: Node, map: BindingMap) => string;
  // Whether typed text needs normalising into chips on blur.
  readonly needsNormalize: (el: HTMLElement) => boolean;
}
export const TEXT_TOKEN_CODEC: BlockCodec = {
  render: renderBlockDom,
  serialize: serializeBlockDom,
  needsNormalize: (el) => hasRawBrackets(el),
};

// True when typed text still contains a bracketed name that should become a chip.
function hasRawBrackets(el: HTMLElement): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && /\[[^\]]+\]/.test(n.textContent ?? '')) return true;
  }
  return false;
}

// Insert a node at a range (or at the end of el) and return the caret position after it.
export function insertAtRange(el: HTMLElement, range: Range | null, nodes: readonly Node[]): void {
  const r = range != null && el.contains(range.startContainer) ? range : null;
  if (r == null) { for (const n of nodes) el.appendChild(n); return; }
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
  text,
  heading,
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
  readonly text: string;
  readonly heading: boolean;
  readonly map: BindingMap;
  readonly placeholder: string;
  readonly testId: string;
  readonly registerEl: (id: string, el: HTMLDivElement | null) => void;
  readonly onChange: (id: string, text: string) => void;
  readonly onSelect: (id: string, range: Range | null) => void;
  readonly onEnter: (id: string) => void;
  readonly codec?: BlockCodec;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return;
    if (codec.serialize(el, map) !== text) codec.render(el, text, map);
  }, [text, map, codec]);

  function sync() { const el = ref.current; if (el != null) onChange(blockId, codec.serialize(el, map)); }
  function saveSel() {
    const el = ref.current;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (el != null && sel != null && sel.rangeCount > 0 && el.contains(sel.anchorNode)) onSelect(blockId, sel.getRangeAt(0).cloneRange());
    else onSelect(blockId, null);
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') { e.preventDefault(); onEnter(blockId); }
  }
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = ref.current;
    if (el == null) return;
    const plain = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ');
    if (plain === '') return;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    insertAtRange(el, sel != null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null, [document.createTextNode(plain)]);
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
  // Rich drops (HTML from another page) are refused — plain text only.
  function onDrop(e: DragEvent<HTMLDivElement>) {
    const types = Array.from(e.dataTransfer?.types ?? []);
    if (types.includes('application/x-aramo-block')) return; // a block reorder — the row handles it
    e.preventDefault();
  }

  return (
    <div
      ref={(el) => { ref.current = el; registerEl(blockId, el); }}
      className={`dt-blk${heading ? ' dt-blk--heading' : ''}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="false"
      aria-label={placeholder}
      tabIndex={0}
      spellCheck
      data-placeholder={placeholder}
      data-testid={testId}
      onInput={() => { sync(); saveSel(); }}
      onBlur={() => {
        const el = ref.current;
        if (el == null) return;
        const t = codec.serialize(el, map);
        if (codec.needsNormalize(el)) codec.render(el, t, map);
        onChange(blockId, t);
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
