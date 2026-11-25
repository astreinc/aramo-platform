import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Button, Input, Select } from '@aramo/fe-foundation';

import {
  STUDIO_TEXT_KINDS,
  chipTokenBeforeCaret,
  indentStudioListItem,
  isStudioTextKind,
  makeStudioChip,
  makeStudioTable,
  outdentStudioListItem,
  parseStudioTable,
  studioActiveMarks,
  studioInsertAtRange,
  studioTableValue,
  studioToggleMark,
  type StudioBlock,
  type StudioBlockKind,
  type StudioCodec,
  type StudioTable,
} from '../studio-codec';

import {
  appendVariable,
  deleteBlock,
  duplicateBlock,
  insertBlocks,
  makeBlock,
  placeBlock,
  setBlockKind,
  setBlockValue,
  shiftBlock,
  type StudioDoc,
} from './doc-ops';
import {
  TABLE_DEFAULT_COLUMNS,
  TABLE_DEFAULT_ROWS,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  addColumn,
  addRow,
  clampTableSize,
  columnsOf,
  removeColumn,
  removeRow,
  setHeader,
  stepCell,
  type TableOpResult,
} from './table-ops';
import { KIND_LABEL, StudioBlockEditable } from './StudioBlockEditable';
import type { StudioDrag } from './use-studio-drag';
import { chipInfo, matchesQuery, type VariableCatalog } from './variables';

// PLATFORM-UX-1 F-9 (handoff §10.4; directive R-11) — the Studio canvas: the toolbar row,
// the A4 page (document title + blocks), the margin "+" / "⋮⋮" controls and the block
// menu, drag and drop, the "/" slash menu, the "{{" variable popover at the caret, the
// floating selection toolbar, Enter / Backspace / ⌥↑↓, ⌘B/I/U, ⌘Z/⌘⇧Z and paste. New
// code over the shared codec; formatting goes through the Range-based toggleMark (no
// document.execCommand).

const NO_MAP = { labelByToken: {}, tokenByLabel: {} };
// TEMPLATE-CONTENT-2 (C-12) — the kinds come from the shared rules: text kinds are converted
// between ("Turn into", the block-type control); the others are inserted.
const KINDS: readonly StudioBlockKind[] = STUDIO_TEXT_KINDS;
const INSERT_KINDS: readonly StudioBlockKind[] = ['table', 'hr', 'page_break'];
const LIST_DEPTH_MESSAGE = 'Lists go two levels deep.';

type TableAct = 'row-above' | 'row-below' | 'row-delete' | 'col-left' | 'col-right' | 'col-delete' | 'header' | 'delete';
const TABLE_ACTS: ReadonlyArray<{ act: TableAct; label: string }> = [
  { act: 'row-above', label: 'Row above' },
  { act: 'row-below', label: 'Row below' },
  { act: 'row-delete', label: 'Delete row' },
  { act: 'col-left', label: 'Column left' },
  { act: 'col-right', label: 'Column right' },
  { act: 'col-delete', label: 'Delete column' },
];

type Mark = 'b' | 'i' | 'u';
interface Pos {
  readonly x: number;
  readonly y: number;
}
interface SlashState extends Pos {
  readonly id: string;
  readonly index: number;
}
interface VarPopState extends Pos {
  readonly brace: boolean;
}

interface SlashItem {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly ok: boolean;
}
// Template Studio.dc.html slash items; TEMPLATE-CONTENT-2 (C-12) enables subheadings, tables,
// dividers and page breaks.
export const SLASH_ITEMS: readonly SlashItem[] = [
  { key: 'p', label: 'Paragraph', desc: 'Plain text', ok: true },
  { key: 'h2', label: 'Heading', desc: 'Section heading (H2)', ok: true },
  { key: 'h3', label: 'Subheading (H3)', desc: 'Heading inside a section', ok: true },
  { key: 'h4', label: 'Small heading (H4)', desc: 'Heading inside a subsection', ok: true },
  { key: 'ul', label: 'Bulleted list', desc: 'Tab indents an item', ok: true },
  { key: 'ol', label: 'Numbered list', desc: 'Tab indents an item', ok: true },
  { key: 'table', label: 'Table', desc: 'Rows and columns', ok: true },
  { key: 'hr', label: 'Divider', desc: 'A horizontal line', ok: true },
  { key: 'page_break', label: 'Page break', desc: 'Start a new page', ok: true },
  { key: 'var', label: 'Variable', desc: 'Insert a {{variable}}', ok: true },
  { key: 'sec', label: 'Section', desc: 'From the section library', ok: true },
];

export interface CanvasHandle {
  /** Insert a chip at the last caret (or append to the selected block). */
  readonly insertVariable: (key: string) => void;
  /** Scroll a block into view and focus it (Outline row click). */
  readonly focusBlock: (id: string) => void;
}

export interface StudioCanvasProps {
  readonly doc: StudioDoc;
  readonly change: (next: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly catalog: VariableCatalog;
  readonly codec: StudioCodec;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly canCopyPublished: boolean;
  readonly onCopyPublished: () => void;
  readonly onOpenSections: () => void;
  readonly onToggleLeft: () => void;
  readonly onToggleRight: () => void;
  readonly toast: (message: string) => void;
  readonly drag: StudioDrag;
  /** TEMPLATE-STUDIO-1 S-1 — the non-editable letterhead slot at the top of the page (organization). */
  readonly letterhead?: ReactNode;
}

function rectOf(el: Element | null): DOMRect | null {
  return el !== null && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
}

function placeCaret(el: HTMLElement, atEnd: boolean, cell?: string): void {
  const kind = el.getAttribute('data-kind');
  if (kind === 'table') {
    const cells = Array.from(el.querySelectorAll<HTMLElement>('[data-cell]'));
    const target = (cell !== undefined ? cells.find((c) => c.getAttribute('data-cell') === cell) : undefined) ?? (atEnd ? cells[cells.length - 1] : cells[0]);
    if (target !== undefined) placeCaret(target, atEnd);
    return;
  }
  el.focus();
  if (kind === 'hr' || kind === 'page_break') return;
  if (typeof window.getSelection !== 'function') return;
  const r = document.createRange();
  r.selectNodeContents(el.querySelector('li:last-child') ?? el);
  r.collapse(!atEnd);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

function isEmptyEl(el: HTMLElement): boolean {
  return (el.textContent ?? '').replace(/\u00a0/g, ' ').trim() === '' && el.querySelector('[data-field]') === null;
}

function elementOf(n: Node | null): Element | null {
  return n === null ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

/** The table cell editor a node sits in, and its "r:c" key. */
function cellOf(n: Node | null): HTMLElement | null {
  return (elementOf(n)?.closest('[data-cell]') as HTMLElement | null) ?? null;
}
function cellPos(cell: Element | null): { r: number; c: number } | null {
  const m = /^(\d+):(\d+)$/.exec(cell?.getAttribute('data-cell') ?? '');
  return m === null ? null : { r: Number(m[1]), c: Number(m[2]) };
}

export const StudioCanvas = forwardRef<CanvasHandle, StudioCanvasProps>(function StudioCanvas(props, handle) {
  const { doc, change, undo, redo, canUndo, canRedo, catalog, codec, selectedId, onSelect, toast, drag } = props;
  const els = useRef(new Map<string, HTMLDivElement>());
  const lastRange = useRef<{ id: string; range: Range } | null>(null);
  const pendingFocus = useRef<{ id: string; atEnd: boolean; cell?: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const [marks, setMarks] = useState({ b: false, i: false, u: false });
  const [float, setFloat] = useState<Pos | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [varPop, setVarPop] = useState<VarPopState | null>(null);
  const [vpq, setVpq] = useState('');
  const [blockMenu, setBlockMenu] = useState<(Pos & { id: string }) | null>(null);
  const [tablePick, setTablePick] = useState<(Pos & { atId: string | null }) | null>(null);
  const [tpRows, setTpRows] = useState(String(TABLE_DEFAULT_ROWS));
  const [tpCols, setTpCols] = useState(String(TABLE_DEFAULT_COLUMNS));

  const docRef = useRef(doc);
  docRef.current = doc;

  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el !== null) els.current.set(id, el);
    else els.current.delete(id);
  }, []);

  const onValue = useCallback(
    (id: string, value: string) => {
      change((d) => {
        const b = d.blocks.find((x) => x.id === id);
        if (b === undefined || b.value === value) return d;
        return { ...d, blocks: setBlockValue(d.blocks, id, value) };
      }, `type:${id}`);
    },
    [change],
  );

  // Focus / caret placement after a structural change (split, delete, move, insert).
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (p === null) return;
    const el = els.current.get(p.id);
    if (el === undefined) return;
    pendingFocus.current = null;
    placeCaret(el, p.atEnd, p.cell);
  });

  // The selection drives the selected block, the B/I/U active state and the floating toolbar.
  useEffect(() => {
    const onSel = (): void => {
      if (typeof window.getSelection !== 'function') return;
      const sel = window.getSelection();
      if (sel === null || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      const host = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const be = host?.closest('[data-block-id]') ?? null;
      if (be === null || rootRef.current === null || !rootRef.current.contains(be)) {
        setFloat(null);
        return;
      }
      const id = be.getAttribute('data-block-id') ?? '';
      const range = sel.getRangeAt(0).cloneRange();
      lastRange.current = { id, range };
      const m = studioActiveMarks(be, range);
      setMarks((prev) => (prev.b === m.b && prev.i === m.i && prev.u === m.u ? prev : m));
      let f: Pos | null = null;
      if (!sel.isCollapsed && sel.toString().trim() !== '' && typeof range.getBoundingClientRect === 'function') {
        const r = range.getBoundingClientRect();
        f = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 46) };
      }
      setFloat((prev) => (prev?.x === f?.x && prev?.y === f?.y ? prev : f));
      onSelect(id);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [onSelect]);

  const kindOf = (id: string): StudioBlockKind => docRef.current.blocks.find((b) => b.id === id)?.kind ?? 'p';

  const syncEl = (id: string): void => {
    const el = els.current.get(id);
    if (el !== undefined) onValue(id, codec.serialize(el, NO_MAP, kindOf(id)));
  };

  const applyMark = (tag: Mark): void => {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    const live = sel !== null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const lr = lastRange.current;
    const id = live !== null ? (live.startContainer.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? lr?.id) : lr?.id;
    if (id === undefined || id === null) {
      toast('Click into the document first.');
      return;
    }
    const el = els.current.get(id);
    if (el === undefined) return;
    const range = live !== null && el.contains(live.startContainer) ? live : lr !== null && lr.id === id ? lr.range : null;
    if (studioToggleMark(el, range, tag)) syncEl(id);
  };

  const appendBlockWith = (key: string): StudioBlock => {
    const b = makeBlock('p');
    return { ...b, value: `<span data-field="${key}"></span>` };
  };

  const insertVariable = (key: string, brace = false): void => {
    setVarPop(null);
    setVpq('');
    const lr = lastRange.current;
    const el = lr !== null ? els.current.get(lr.id) : undefined;
    if (lr === null || el === undefined || !el.isConnected || !el.contains(lr.range.startContainer)) {
      const blocks = docRef.current.blocks;
      const target = blocks.find((b) => b.id === selectedId) ?? blocks[blocks.length - 1];
      if (target === undefined) change((d) => ({ ...d, blocks: [...d.blocks, appendBlockWith(key)] }));
      else if (target.kind === 'hr' || target.kind === 'page_break') change((d) => ({ ...d, blocks: insertBlocks(d.blocks, [appendBlockWith(key)], target.id) }));
      else change((d) => ({ ...d, blocks: appendVariable(d.blocks, target.id, key) }));
      toast(`Inserted {{${key}}}.`);
      return;
    }
    const r = lr.range;
    const n = r.startContainer;
    if (brace && n.nodeType === Node.TEXT_NODE && r.startOffset >= 2 && (n.textContent ?? '').slice(r.startOffset - 2, r.startOffset) === '{{') {
      r.setStart(n, r.startOffset - 2);
      r.deleteContents();
    }
    (cellOf(r.startContainer) ?? el).focus();
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    sel?.removeAllRanges();
    sel?.addRange(r);
    studioInsertAtRange(el, r, [makeStudioChip(key, chipInfo(catalog, key)), document.createTextNode('\u00a0')]);
    syncEl(lr.id);
  };

  useImperativeHandle(handle, () => ({
    insertVariable: (key: string) => insertVariable(key),
    focusBlock: (id: string) => {
      const el = els.current.get(id);
      const sc = scrollRef.current;
      if (el !== undefined && sc !== null) {
        const er = rectOf(el);
        const sr = rectOf(sc);
        if (er !== null && sr !== null) sc.scrollTop += er.top - sr.top - 90;
      }
      if (el !== undefined) placeCaret(el, true);
      onSelect(id);
    },
  }));

  const insertAfter = (afterId: string | null, kind: StudioBlockKind): void => {
    const nb = makeBlock(kind);
    pendingFocus.current = { id: nb.id, atEnd: false };
    change((d) => ({ ...d, blocks: insertBlocks(d.blocks, [nb], afterId) }));
  };

  const setKind = (id: string, kind: StudioBlockKind): void => {
    pendingFocus.current = { id, atEnd: true };
    change((d) => ({ ...d, blocks: setBlockKind(d.blocks, id, kind) }));
  };

  // TEMPLATE-CONTENT-2 — insert a table, divider or page break at `atId` (it replaces an empty
  // line). When it lands last, an empty paragraph follows so typing can go on below it.
  const insertSpecial = (atId: string | null, nb: StudioBlock): void => {
    const trail = makeBlock('p');
    const last = (() => {
      const placed = placeBlock(docRef.current.blocks, nb, atId);
      return placed[placed.length - 1]?.id === nb.id;
    })();
    pendingFocus.current = nb.kind === 'table' || !last ? { id: nb.id, atEnd: false } : { id: trail.id, atEnd: false };
    change((d) => {
      const placed = placeBlock(d.blocks, nb, atId);
      return { ...d, blocks: placed[placed.length - 1]?.id === nb.id ? [...placed, trail] : placed };
    });
  };

  const openTablePick = (atId: string | null, at: Pos): void => {
    setTpRows(String(TABLE_DEFAULT_ROWS));
    setTpCols(String(TABLE_DEFAULT_COLUMNS));
    setTablePick({ atId, x: at.x, y: at.y });
  };

  const insertTable = (): void => {
    if (tablePick === null) return;
    const { rows, cols } = clampTableSize(Number(tpRows), Number(tpCols));
    setTablePick(null);
    insertSpecial(tablePick.atId, { ...makeBlock('table'), value: studioTableValue(makeStudioTable(rows, cols, true)) });
  };

  /** Insert (or turn into) a kind from the "/" menu or the block-type control. */
  const chooseKind = (id: string, kind: StudioBlockKind, at: Pos): void => {
    const cur = docRef.current.blocks.find((b) => b.id === id);
    if (kind === 'table') openTablePick(id, at);
    else if (!isStudioTextKind(kind)) insertSpecial(id, makeBlock(kind));
    else if (cur !== undefined && !isStudioTextKind(cur.kind)) insertAfter(id, kind);
    else setKind(id, kind);
  };

  // ── Tables (C-13) ──
  const currentTable = (id: string): StudioTable | null => {
    const b = docRef.current.blocks.find((x) => x.id === id);
    if (b === undefined || b.kind !== 'table') return null;
    const el = els.current.get(id);
    return parseStudioTable(el !== undefined ? codec.serialize(el, NO_MAP, 'table') : b.value);
  };

  const removeBlockAndFocus = (id: string): void => {
    const blocks = docRef.current.blocks;
    const i = blocks.findIndex((x) => x.id === id);
    const near = blocks[i - 1] ?? blocks[i + 1];
    if (near !== undefined) pendingFocus.current = { id: near.id, atEnd: true };
    onSelect(near?.id ?? null);
    change((d) => ({ ...d, blocks: deleteBlock(d.blocks, id) }));
  };

  const tableAct = (id: string, act: TableAct, from?: { r: number; c: number } | null): void => {
    const t = currentTable(id);
    if (t === null) return;
    if (act === 'delete') {
      removeBlockAndFocus(id);
      toast('Table deleted.');
      return;
    }
    const lr = lastRange.current;
    const pos = from ?? (lr !== null && lr.id === id ? cellPos(cellOf(lr.range.startContainer)) : null) ?? { r: t.rows.length - 1, c: columnsOf(t) - 1 };
    const { r, c } = pos;
    let res: TableOpResult | StudioTable | null;
    let focus = { r, c };
    if (act === 'row-above') {
      const i = Math.max(t.header ? 1 : 0, r);
      res = addRow(t, i);
      focus = { r: i, c };
    } else if (act === 'row-below') {
      res = addRow(t, r + 1);
      focus = { r: Math.max(t.header ? 1 : 0, r + 1), c };
    } else if (act === 'row-delete') {
      res = removeRow(t, r);
      focus = { r: Math.max(0, Math.min(r, t.rows.length - 2)), c };
    } else if (act === 'col-left') {
      res = addColumn(t, c);
    } else if (act === 'col-right') {
      res = addColumn(t, c + 1);
      focus = { r, c: c + 1 };
    } else if (act === 'col-delete') {
      res = removeColumn(t, c);
      focus = { r, c: Math.max(0, Math.min(c, columnsOf(t) - 2)) };
    } else {
      res = setHeader(t, !t.header);
    }
    if (res === null) {
      removeBlockAndFocus(id);
      toast('Table deleted.');
      return;
    }
    if ('limit' in res) {
      toast(res.limit);
      return;
    }
    const next = 'table' in res ? res.table : res;
    pendingFocus.current = { id, atEnd: true, cell: `${focus.r}:${focus.c}` };
    change((d) => ({ ...d, blocks: setBlockValue(d.blocks, id, studioTableValue(next)) }));
  };

  // ── Lists two levels deep (C-14): Tab / Shift+Tab ──
  const shiftListItem = (b: StudioBlock, el: HTMLDivElement, out: boolean): void => {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    const r = sel !== null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const li = (elementOf(r?.startContainer ?? null)?.closest('li') as HTMLElement | null) ?? null;
    if (r === null || li === null || !el.contains(li)) return;
    const caret = { node: r.startContainer, offset: r.startOffset };
    if (out) {
      if (!outdentStudioListItem(li)) return;
    } else {
      const res = indentStudioListItem(li, el);
      if (res === 'too_deep') {
        toast(LIST_DEPTH_MESSAGE);
        return;
      }
      if (res === 'no_prev') return;
    }
    if (li.contains(caret.node) && sel !== null) {
      const nr = document.createRange();
      nr.setStart(caret.node, Math.min(caret.offset, caret.node.nodeType === Node.TEXT_NODE ? (caret.node.textContent ?? '').length : caret.node.childNodes.length));
      nr.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nr);
    }
    syncEl(b.id);
  };

  const pickSlash = (item: SlashItem, s: SlashState): void => {
    if (!item.ok) return;
    setSlash(null);
    if (item.key === 'table' || item.key === 'hr' || item.key === 'page_break') {
      chooseKind(s.id, item.key, { x: s.x, y: s.y });
      return;
    }
    if (item.key === 'var') {
      const el = els.current.get(s.id);
      if (el !== undefined) {
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el.querySelector('li:last-child') ?? el);
        r.collapse(false);
        lastRange.current = { id: s.id, range: r };
      }
      setVpq('');
      setVarPop({ x: s.x, y: s.y, brace: false });
    } else if (item.key === 'sec') {
      props.onOpenSections();
    } else {
      setKind(s.id, item.key as StudioBlockKind);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, b: StudioBlock, el: HTMLDivElement): void => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (slash !== null && slash.id === b.id) {
      const enabled = SLASH_ITEMS.map((x, i) => (x.ok ? i : -1)).filter((i) => i >= 0);
      const at = enabled.indexOf(slash.index);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = enabled[(at + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length] ?? 0;
        setSlash({ ...slash, index: next });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = SLASH_ITEMS[slash.index];
        if (item !== undefined) pickSlash(item, slash);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return;
      }
      setSlash(null);
    }
    const textual = isStudioTextKind(b.kind);
    // A divider / page break: Enter adds a paragraph below, Backspace / Delete removes it.
    if (b.kind === 'hr' || b.kind === 'page_break') {
      if (e.key === 'Enter') {
        e.preventDefault();
        insertAfter(b.id, 'p');
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        removeBlockAndFocus(b.id);
        return;
      }
    }
    // A table: Tab / Shift+Tab move between cells (Tab in the last cell adds a row); Enter is a
    // line break inside the cell.
    if (b.kind === 'table' && e.key === 'Tab' && !mod && !e.altKey) {
      const cell = cellOf(e.target as Node);
      const pos = cellPos(cell);
      const t = currentTable(b.id);
      if (pos !== null && t !== null) {
        const next = stepCell(t, pos.r, pos.c, e.shiftKey ? -1 : 1);
        if (next !== null) {
          e.preventDefault();
          placeCaret(el, true, `${next.r}:${next.c}`);
        } else if (!e.shiftKey) {
          e.preventDefault();
          tableAct(b.id, 'row-below', { r: t.rows.length - 1, c: 0 });
        }
        return;
      }
    }
    if ((b.kind === 'ul' || b.kind === 'ol') && e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      shiftListItem(b, el, e.shiftKey);
      return;
    }
    if (e.key === '/' && !mod && textual && isEmptyEl(el)) {
      e.preventDefault();
      const r = rectOf(el);
      setSlash({ id: b.id, x: Math.round(r?.left ?? 0), y: Math.round((r?.bottom ?? 0) + 6), index: 0 });
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      pendingFocus.current = { id: b.id, atEnd: true };
      change((d) => ({ ...d, blocks: shiftBlock(d.blocks, b.id, e.key === 'ArrowUp' ? -1 : 1) }));
      return;
    }
    if (mod && !e.shiftKey && (key === 'b' || key === 'i' || key === 'u')) {
      e.preventDefault();
      applyMark(key);
      return;
    }
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Enter') {
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (e.shiftKey || b.kind === 'table') {
        e.preventDefault();
        const br = document.createElement('br');
        const nodes: Node[] = [br];
        studioInsertAtRange(el, sel !== null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null, nodes);
        if (br.nextSibling === null) br.parentNode?.appendChild(document.createElement('br'));
        syncEl(b.id);
        return;
      }
      if (b.kind === 'ul' || b.kind === 'ol') {
        const anchor = sel?.anchorNode ?? null;
        const host = anchor === null ? null : anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
        const li = host?.closest('li') ?? null;
        if (li !== null && el.contains(li) && (li.textContent ?? '').trim() === '' && li.nextElementSibling === null) {
          // Enter on an empty last item leaves the list: a new paragraph below.
          e.preventDefault();
          li.remove();
          const head = codec.serialize(el, NO_MAP, b.kind);
          const nb = makeBlock('p');
          pendingFocus.current = { id: nb.id, atEnd: false };
          change((d) => ({ ...d, blocks: insertBlocks(setBlockValue(d.blocks, b.id, head), [nb], b.id) }));
        }
        return; // otherwise the browser adds the next list item
      }
      e.preventDefault();
      if (sel === null || sel.rangeCount === 0) {
        insertAfter(b.id, 'p');
        return;
      }
      const r = sel.getRangeAt(0);
      if (!el.contains(r.startContainer)) return;
      if (!r.collapsed) r.deleteContents();
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEnd(el, el.childNodes.length);
      const tmp = document.createElement('div');
      tmp.appendChild(tail.extractContents());
      const head = codec.serialize(el, NO_MAP, b.kind);
      const rest = codec.serialize(tmp, NO_MAP, 'p');
      const nb = { ...makeBlock('p'), value: rest };
      pendingFocus.current = { id: nb.id, atEnd: false };
      change((d) => ({ ...d, blocks: insertBlocks(setBlockValue(d.blocks, b.id, head), [nb], b.id) }));
      return;
    }
    if (e.key === 'Backspace' && textual && isEmptyEl(el)) {
      const blocks = docRef.current.blocks;
      if (blocks.length <= 1) return;
      e.preventDefault();
      const i = blocks.findIndex((x) => x.id === b.id);
      const prev = blocks[i - 1] ?? blocks[i + 1];
      if (prev !== undefined) pendingFocus.current = { id: prev.id, atEnd: true };
      change((d) => ({ ...d, blocks: deleteBlock(d.blocks, b.id) }));
    }
  };

  const onKeyUpBlock = (e: KeyboardEvent<HTMLDivElement>, b: StudioBlock): void => {
    if (e.key !== '{' && e.key !== '}') return;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (sel === null || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (e.key === '}') {
      // TEMPLATE-CONTENT-2 (C-16) — a typed `{{key}}` of a known variable becomes a chip as it
      // is closed; an unknown key stays text (readiness reports it).
      const done = chipTokenBeforeCaret(r, (k) => chipInfo(catalog, k).state !== 'unknown', (k) => makeStudioChip(k, chipInfo(catalog, k)));
      if (done !== null) syncEl(b.id);
      return;
    }
    const n = r.startContainer;
    if (n.nodeType === Node.TEXT_NODE && r.startOffset >= 2 && (n.textContent ?? '').slice(r.startOffset - 2, r.startOffset) === '{{') {
      lastRange.current = { id: b.id, range: r.cloneRange() };
      const rc = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null;
      setVpq('');
      setVarPop({ x: Math.round(rc?.left ?? 0), y: Math.round((rc?.bottom ?? 0) + 6), brace: true });
    }
  };

  const onFocusBlock = useCallback((id: string) => onSelect(id), [onSelect]);
  const onPasted = useCallback(() => toast('Pasted as plain text. Formatting outside the allowed set is removed.'), [toast]);

  const closePops = (): void => {
    setSlash(null);
    setVarPop(null);
    setBlockMenu(null);
    setTablePick(null);
  };

  // Esc closes the canvas menus and popovers.
  useEffect(() => {
    if (slash === null && varPop === null && blockMenu === null && tablePick === null) return undefined;
    const onEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closePops();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [slash, varPop, blockMenu, tablePick]);

  const selected = doc.blocks.find((b) => b.id === selectedId) ?? null;
  const keep = (e: ReactMouseEvent): void => e.preventDefault(); // keep the caret / selection
  const vpItems = catalog.list.filter((v) => v.insertable && matchesQuery(v, vpq)).slice(0, 9);
  const menuBlock = blockMenu !== null ? doc.blocks.find((b) => b.id === blockMenu.id) ?? null : null;
  const anyPop = slash !== null || varPop !== null || blockMenu !== null || tablePick !== null;

  const fmt: ReadonlyArray<{ tag: Mark; l: string; tt: string }> = [
    { tag: 'b', l: 'B', tt: 'Bold (⌘B)' },
    { tag: 'i', l: 'I', tt: 'Italic (⌘I)' },
    { tag: 'u', l: 'U', tt: 'Underline (⌘U)' },
  ];

  return (
    <section aria-label="Document" className="pws-doc" ref={rootRef}>
      <div role="toolbar" aria-label="Formatting" className="pws-tb">
        <Button unstyled className="pws-tb__icon" title="Outline" aria-label="Toggle outline" onClick={props.onToggleLeft}>
          <PanelGlyph side="left" />
        </Button>
        <span className="pws-tb__sep" aria-hidden="true" />
        <Select
          unstyled
          className="pws-tb__select"
          aria-label="Block type"
          value={selected?.kind ?? 'p'}
          disabled={selected === null}
          onChange={(e) => {
            if (selected === null) return;
            const r = rectOf(e.currentTarget);
            chooseKind(selected.id, e.target.value as StudioBlockKind, { x: Math.round(r?.left ?? 0), y: Math.round((r?.bottom ?? 0) + 6) });
          }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
          <optgroup label="Insert">
            {INSERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </optgroup>
        </Select>
        <span className="pws-tb__sep" aria-hidden="true" />
        {fmt.map((f) => (
          <Button
            key={f.tag}
            unstyled
            className={`pws-tb__fmt pws-tb__fmt--${f.tag}${marks[f.tag] ? ' pws-tb__fmt--on' : ''}`}
            title={f.tt}
            aria-label={f.tt}
            aria-pressed={marks[f.tag]}
            onMouseDown={(e) => {
              keep(e);
              applyMark(f.tag);
            }}
          >
            {f.l}
          </Button>
        ))}
        <Button
          unstyled
          className="pws-tb__icon pws-tb__icon--auto"
          title="Bulleted list"
          aria-label="Bulleted list"
          onMouseDown={(e) => {
            keep(e);
            if (selected !== null) setKind(selected.id, selected.kind === 'ul' ? 'p' : 'ul');
          }}
        >
          <BulletGlyph />
        </Button>
        <Button
          unstyled
          className="pws-tb__icon pws-tb__icon--auto pws-tb__num"
          title="Numbered list"
          onMouseDown={(e) => {
            keep(e);
            if (selected !== null) setKind(selected.id, selected.kind === 'ol' ? 'p' : 'ol');
          }}
        >
          {/* The visible "1." is decorative; the name is the sr-only text (an aria-label
              that omits the visible text fails WCAG 2.5.3 label-in-name). */}
          <span aria-hidden="true">1.</span>
          <span className="pws-sr">Numbered list</span>
        </Button>
        <Button
          unstyled
          className="pws-tb__icon pws-tb__icon--auto pws-tb__br"
          title="Line break (⇧ Enter)"
          aria-label="Line break"
          onMouseDown={(e) => {
            keep(e);
            const lr = lastRange.current;
            const el = lr !== null ? els.current.get(lr.id) : undefined;
            if (lr === null || el === undefined) {
              toast('Click into the document first.');
              return;
            }
            studioInsertAtRange(el, lr.range, [document.createElement('br')]);
            syncEl(lr.id);
          }}
        >
          ↵
        </Button>
        <span className="pws-tb__sep" aria-hidden="true" />
        <Button
          unstyled
          className="pws-tb__var"
          title="Insert variable (type {{ in text)"
          onMouseDown={(e) => {
            keep(e);
            const r = rectOf(e.currentTarget);
            setVpq('');
            setVarPop({ x: Math.round(r?.left ?? 0), y: Math.round((r?.bottom ?? 0) + 6), brace: false });
          }}
        >
          + Variable
        </Button>
        <Button
          unstyled
          className="pws-tb__sec"
          title="Insert a section"
          onMouseDown={(e) => {
            keep(e);
            props.onOpenSections();
          }}
        >
          + Section
        </Button>
        <span className="pws-tb__sep" aria-hidden="true" />
        <Button unstyled className="pws-tb__icon pws-tb__icon--auto pws-tb__hist" title="Undo (⌘Z)" aria-label="Undo" disabled={!canUndo} onMouseDown={(e) => { keep(e); undo(); }}>
          ↶
        </Button>
        <Button unstyled className="pws-tb__icon pws-tb__icon--auto pws-tb__hist" title="Redo (⌘⇧Z)" aria-label="Redo" disabled={!canRedo} onMouseDown={(e) => { keep(e); redo(); }}>
          ↷
        </Button>
        <span className="pws-tb__gap" title="Outside the allowed content set">
          {['Align', 'Conditional'].map((l) => (
            <Button key={l} unstyled className="pws-tb__off" disabled>
              {l}
            </Button>
          ))}
        </span>
        <Button unstyled className="pws-tb__icon pws-tb__inspector" title="Inspector" aria-label="Toggle inspector" onClick={props.onToggleRight}>
          <PanelGlyph side="right" />
        </Button>
      </div>

      <div ref={scrollRef} className="pws-doc__scroll" onDragOver={(e) => drag.overCanvas(e)} onDrop={(e) => drag.drop(e, null)}>
        <div className="pws-page">
          {props.letterhead}
          <label className="pws-page__title">
            <span className="pws-page__title-l">Document title</span>
            <Input
              unstyled
              className="pws-page__title-in"
              value={doc.title}
              placeholder="Untitled document"
              onChange={(e) => {
                const title = e.target.value;
                change((d) => ({ ...d, title }), 'title');
              }}
            />
          </label>

          {doc.blocks.length === 0 ? (
            <div className="pws-start">
              <div className="pws-start__t">Start this template</div>
              <p className="pws-start__p">
                Write from scratch, drag a section from the library, or copy the published version. Type <b>/</b> for blocks and{' '}
                <b>{'{{'}</b> for variables.
              </p>
              <div className="pws-start__acts">
                <Button unstyled className="pws-btn34 pws-btn34--dark" onClick={() => insertAfter(null, 'h2')}>
                  Add a heading
                </Button>
                <Button unstyled className="pws-btn34" onClick={() => insertAfter(null, 'p')}>
                  Add a paragraph
                </Button>
                <Button unstyled className="pws-btn34" onClick={props.onOpenSections}>
                  Browse sections
                </Button>
                {props.canCopyPublished ? (
                  <Button unstyled className="pws-btn34" onClick={props.onCopyPublished}>
                    Copy published version
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {doc.blocks.map((b) => {
            const on = b.id === selectedId;
            const d = drag.dropAt;
            return (
              <div
                key={b.id}
                className={`pws-row${on ? ' pws-row--sel' : ''}`}
                data-row={b.id}
                onDragOver={(e) => drag.over(e, b.id)}
                onDrop={(e) => drag.drop(e, b.id)}
              >
                {d !== null && d.id === b.id && d.pos === 'before' ? <div className="pws-drop pws-drop--before" aria-hidden="true" /> : null}
                <div className="pws-row__ctrl">
                  <Button unstyled className="pws-row__btn pws-row__add" title="Add block below" aria-label="Add block below" onClick={() => insertAfter(b.id, 'p')}>
                    +
                  </Button>
                  <Button
                    unstyled
                    className="pws-row__btn pws-row__grip"
                    draggable
                    title="Drag to move · click for options"
                    aria-label="Block options"
                    aria-haspopup="menu"
                    onDragStart={(e) => drag.start(e, { kind: 'block', id: b.id })}
                    onDragEnd={drag.end}
                    onClick={(e) => {
                      const r = rectOf(e.currentTarget);
                      onSelect(b.id);
                      setBlockMenu({ id: b.id, x: Math.round(r?.left ?? 0), y: Math.round((r?.bottom ?? 0) + 4) });
                    }}
                  >
                    ⋮⋮
                  </Button>
                </div>
                {on ? <span className="pws-row__tag">{KIND_LABEL[b.kind]}</span> : null}
                {on && b.kind === 'table' ? (
                  <div role="toolbar" aria-label="Table" className="pws-tbltb">
                    {TABLE_ACTS.map((a) => (
                      <Button key={a.act} unstyled className="pws-tbltb__b" onMouseDown={keep} onClick={() => tableAct(b.id, a.act)}>
                        {a.label}
                      </Button>
                    ))}
                    <Button
                      unstyled
                      className="pws-tbltb__b"
                      aria-pressed={parseStudioTable(b.value).header}
                      onMouseDown={keep}
                      onClick={() => tableAct(b.id, 'header')}
                    >
                      Header row
                    </Button>
                    <Button unstyled className="pws-tbltb__b pws-tbltb__b--danger" onMouseDown={keep} onClick={() => tableAct(b.id, 'delete')}>
                      Delete table
                    </Button>
                  </div>
                ) : null}
                <StudioBlockEditable
                  block={b}
                  codec={codec}
                  register={register}
                  onValue={onValue}
                  onKey={onKey}
                  onKeyUpBlock={onKeyUpBlock}
                  onFocusBlock={onFocusBlock}
                  onPasted={onPasted}
                />
                {d !== null && d.id === b.id && d.pos === 'after' ? <div className="pws-drop pws-drop--after" aria-hidden="true" /> : null}
              </div>
            );
          })}
          {drag.dragging ? (
            <div className="pws-dropend" onDragOver={(e) => drag.overCanvas(e)} onDrop={(e) => drag.drop(e, null)}>
              Drop here to add at the end
            </div>
          ) : null}
        </div>
      </div>

      {anyPop ? <div className="pws-scrim" aria-hidden="true" onMouseDown={closePops} /> : null}

      {float !== null && !anyPop ? (
        <div role="toolbar" aria-label="Selection" className="pws-float" style={{ left: float.x, top: float.y }}>
          {fmt.map((f) => (
            <Button
              key={f.tag}
              unstyled
              className={`pws-float__fmt pws-tb__fmt--${f.tag}`}
              aria-label={f.tt}
              aria-pressed={marks[f.tag]}
              onMouseDown={(e) => {
                keep(e);
                applyMark(f.tag);
              }}
            >
              {f.l}
            </Button>
          ))}
          <span className="pws-float__sep" aria-hidden="true" />
          <Button
            unstyled
            className="pws-float__var"
            onMouseDown={(e) => {
              keep(e);
              setVpq('');
              setVarPop({ x: float.x - 140, y: float.y + 48, brace: false });
            }}
          >
            + Variable
          </Button>
        </div>
      ) : null}

      {varPop !== null ? (
        <div role="dialog" aria-label="Insert variable" className="pws-vp" style={{ left: varPop.x, top: varPop.y }}>
          <Input
            unstyled
            autoFocus
            className="pws-vp__q"
            value={vpq}
            placeholder="Search variables — Enter picks the first"
            aria-label="Search variables"
            onChange={(e) => setVpq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const first = vpItems[0];
                if (first !== undefined) {
                  e.preventDefault();
                  insertVariable(first.key, varPop.brace);
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setVarPop(null);
                const lr = lastRange.current;
                const el = lr !== null ? els.current.get(lr.id) : undefined;
                el?.focus();
              }
            }}
          />
          <div className="pws-vp__list">
            {vpItems.map((v) => (
              <Button
                key={v.key}
                unstyled
                className="pws-vp__item"
                onMouseDown={(e) => {
                  keep(e);
                  insertVariable(v.key, varPop.brace);
                }}
              >
                <span className="pws-vp__label">{v.label}</span>
                <span className="pws-vp__group">{v.group}</span>
                <span className="pws-vp__key">{v.key}</span>
                <span className="pws-vp__sample">{v.sample}</span>
              </Button>
            ))}
            {vpItems.length === 0 ? <div className="pws-vp__none">No variables match.</div> : null}
          </div>
        </div>
      ) : null}

      {slash !== null ? (
        <div role="menu" aria-label="Blocks" className="pws-menu pws-menu--slash" style={{ left: slash.x, top: slash.y }}>
          <div className="pws-menu__head">Insert or turn into</div>
          {SLASH_ITEMS.map((x, i) => (
            <Button
              key={x.key}
              unstyled
              role="menuitem"
              className={`pws-menu__item pws-menu__item--two${i === slash.index ? ' pws-menu__item--hl' : ''}${x.ok ? '' : ' pws-menu__item--off'}`}
              aria-disabled={!x.ok}
              onMouseDown={(e) => {
                keep(e);
                pickSlash(x, slash);
              }}
            >
              <span className="pws-menu__l">{x.label}</span>
              {x.desc !== '' ? <span className="pws-menu__d">{x.desc}</span> : null}
            </Button>
          ))}
        </div>
      ) : null}

      {tablePick !== null ? (
        <div role="dialog" aria-label="Insert table" className="pws-vp pws-tp" style={{ left: tablePick.x, top: tablePick.y }}>
          <div className="pws-tp__row">
            <label className="pws-tp__f">
              <span>Rows</span>
              <Input
                unstyled
                autoFocus
                type="number"
                min={1}
                max={TABLE_MAX_ROWS}
                className="pws-tp__in"
                value={tpRows}
                onChange={(e) => setTpRows(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    insertTable();
                  }
                }}
              />
            </label>
            <span aria-hidden="true">×</span>
            <label className="pws-tp__f">
              <span>Columns</span>
              <Input
                unstyled
                type="number"
                min={1}
                max={TABLE_MAX_COLUMNS}
                className="pws-tp__in"
                value={tpCols}
                onChange={(e) => setTpCols(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    insertTable();
                  }
                }}
              />
            </label>
          </div>
          <div className="pws-tp__hint">
            Up to {TABLE_MAX_ROWS} rows and {TABLE_MAX_COLUMNS} columns. The first row is a header row.
          </div>
          <Button unstyled className="pws-btn34 pws-btn34--dark" onClick={insertTable}>
            Insert table
          </Button>
        </div>
      ) : null}

      {blockMenu !== null && menuBlock !== null ? (
        <div role="menu" aria-label="Block options" className="pws-menu pws-menu--block" style={{ left: blockMenu.x, top: blockMenu.y }}>
          {isStudioTextKind(menuBlock.kind) ? <div className="pws-menu__head">Turn into</div> : null}
          {(isStudioTextKind(menuBlock.kind) ? KINDS : []).map((k) => (
            <Button
              key={k}
              unstyled
              role="menuitem"
              className="pws-menu__item"
              onClick={() => {
                setBlockMenu(null);
                setKind(menuBlock.id, k);
              }}
            >
              <span className="pws-menu__grow">{KIND_LABEL[k]}</span>
              <b>{menuBlock.kind === k ? '✓' : ''}</b>
            </Button>
          ))}
          <div className="pws-menu__rule" />
          <Button
            unstyled
            role="menuitem"
            className="pws-menu__item"
            onClick={() => {
              setBlockMenu(null);
              change((d) => ({ ...d, blocks: duplicateBlock(d.blocks, menuBlock.id) }));
              toast('Block duplicated.');
            }}
          >
            Duplicate
          </Button>
          <Button
            unstyled
            role="menuitem"
            className="pws-menu__item"
            onClick={() => {
              setBlockMenu(null);
              change((d) => ({ ...d, blocks: shiftBlock(d.blocks, menuBlock.id, -1) }));
            }}
          >
            <span className="pws-menu__grow">Move up</span>
            <span className="pws-menu__kbd">⌥↑</span>
          </Button>
          <Button
            unstyled
            role="menuitem"
            className="pws-menu__item"
            onClick={() => {
              setBlockMenu(null);
              change((d) => ({ ...d, blocks: shiftBlock(d.blocks, menuBlock.id, 1) }));
            }}
          >
            <span className="pws-menu__grow">Move down</span>
            <span className="pws-menu__kbd">⌥↓</span>
          </Button>
          <Button
            unstyled
            role="menuitem"
            className="pws-menu__item pws-menu__item--danger"
            onClick={() => {
              setBlockMenu(null);
              onSelect(null);
              change((d) => ({ ...d, blocks: deleteBlock(d.blocks, menuBlock.id) }));
              toast('Block deleted.');
            }}
          >
            Delete block
          </Button>
        </div>
      ) : null}
    </section>
  );
});

function PanelGlyph({ side }: { readonly side: 'left' | 'right' }) {
  const x = side === 'left' ? 9.5 : 14.5;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <line x1={x} y1="4.5" x2={x} y2="19.5" />
    </svg>
  );
}

function BulletGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}
