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
} from 'react';
import { Button, Input, Select } from '@aramo/fe-foundation';

import {
  makeStudioChip,
  studioActiveMarks,
  studioInsertAtRange,
  studioToggleMark,
  type StudioBlock,
  type StudioBlockKind,
  type StudioCodec,
} from '../studio-codec';

import {
  appendVariable,
  deleteBlock,
  duplicateBlock,
  insertBlocks,
  makeBlock,
  setBlockKind,
  setBlockValue,
  shiftBlock,
  type StudioDoc,
} from './doc-ops';
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
const KINDS: readonly StudioBlockKind[] = ['p', 'h2', 'ul', 'ol'];

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
// Template Studio.dc.html slash items (Subheading and Table are outside the allowed set).
export const SLASH_ITEMS: readonly SlashItem[] = [
  { key: 'p', label: 'Paragraph', desc: 'Plain text', ok: true },
  { key: 'h2', label: 'Heading', desc: 'Section heading (H2)', ok: true },
  { key: 'ul', label: 'Bulleted list', desc: '', ok: true },
  { key: 'ol', label: 'Numbered list', desc: '', ok: true },
  { key: 'var', label: 'Variable', desc: 'Insert a {{variable}}', ok: true },
  { key: 'sec', label: 'Section', desc: 'From the section library', ok: true },
  { key: 'h3', label: 'Subheading (H3)', desc: 'Not in the allowed content set', ok: false },
  { key: 'table', label: 'Table', desc: 'Not in the allowed content set', ok: false },
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
}

function rectOf(el: Element | null): DOMRect | null {
  return el !== null && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
}

function placeCaret(el: HTMLElement, atEnd: boolean): void {
  el.focus();
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

export const StudioCanvas = forwardRef<CanvasHandle, StudioCanvasProps>(function StudioCanvas(props, handle) {
  const { doc, change, undo, redo, canUndo, canRedo, catalog, codec, selectedId, onSelect, toast, drag } = props;
  const els = useRef(new Map<string, HTMLDivElement>());
  const lastRange = useRef<{ id: string; range: Range } | null>(null);
  const pendingFocus = useRef<{ id: string; atEnd: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const [marks, setMarks] = useState({ b: false, i: false, u: false });
  const [float, setFloat] = useState<Pos | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [varPop, setVarPop] = useState<VarPopState | null>(null);
  const [vpq, setVpq] = useState('');
  const [blockMenu, setBlockMenu] = useState<(Pos & { id: string }) | null>(null);

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
    placeCaret(el, p.atEnd);
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
    el.focus();
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

  const pickSlash = (item: SlashItem, s: SlashState): void => {
    if (!item.ok) return;
    setSlash(null);
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
    if (e.key === '/' && !mod && isEmptyEl(el)) {
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
      if (e.shiftKey) {
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
    if (e.key === 'Backspace' && isEmptyEl(el)) {
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
    if (e.key !== '{') return;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (sel === null || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
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
  };

  // Esc closes the canvas menus and popovers.
  useEffect(() => {
    if (slash === null && varPop === null && blockMenu === null) return undefined;
    const onEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closePops();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [slash, varPop, blockMenu]);

  const selected = doc.blocks.find((b) => b.id === selectedId) ?? null;
  const keep = (e: ReactMouseEvent): void => e.preventDefault(); // keep the caret / selection
  const vpItems = catalog.list.filter((v) => v.insertable && matchesQuery(v, vpq)).slice(0, 9);
  const menuBlock = blockMenu !== null ? doc.blocks.find((b) => b.id === blockMenu.id) ?? null : null;
  const anyPop = slash !== null || varPop !== null || blockMenu !== null;

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
            if (selected !== null) setKind(selected.id, e.target.value as StudioBlockKind);
          }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
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
          {['Table', 'H3', 'Align', 'Conditional'].map((l) => (
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

      {blockMenu !== null && menuBlock !== null ? (
        <div role="menu" aria-label="Block options" className="pws-menu pws-menu--block" style={{ left: blockMenu.x, top: blockMenu.y }}>
          <div className="pws-menu__head">Turn into</div>
          {KINDS.map((k) => (
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
