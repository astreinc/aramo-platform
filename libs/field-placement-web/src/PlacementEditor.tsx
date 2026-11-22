import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { type FieldSurface, type FieldTypeKey } from '@aramo/sign-fields';

import { PlacementPages, defaultFace, pageSlotsOf, type FieldFace, type PageRenderer, type PageSlot } from './PlacementPages';
import {
  assignField,
  configureField,
  editorReducer,
  initialEditorState,
  nudgeFields,
  placeField,
  removeFields,
  resizeFields,
  type CommandContext,
  type DragPrecision,
  type EditorAction,
  type EditorState,
} from './lib/editor-state';
import { clampBox, toPdf } from './lib/geometry';
import { fieldKeyIntent, isTextControl, isUndoKey } from './lib/keymap';
import {
  DEFAULT_SETTINGS,
  editableSettingsOf,
  paletteFor,
  typeLabelOf,
  type PageRef,
  type PaletteEntry,
  type PlacedField,
  type PlacementAssignee,
  type PlacementCapabilities,
  type PlacementDocument,
  type PlacementPrefill,
} from './lib/model';
import { groupSize } from './lib/settings';
import { pickTargetPage, placeNewField, visibleArea, visibleRegionInPage, type ScreenRect } from './lib/viewport';
import './field-placement.css';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-5,
// ruling R-8 — the ONE web placement editor, used by sign-web Prepare and the console's
// fixed-form Studio. Catalog-driven palette (fieldTypesFor(surface)), the page column, the field
// settings panel, the keyboard map and undo. The host supplies its data (documents and a page
// renderer, its fields mapped to PlacedField, who may fill a field, what its API accepts) and
// keeps its own chrome and API calls; the editor reports every edit through onChange.
//
// Mouse: pick a type, then click the page (arm mode) — or a click adds it in view (add mode);
// drag to move; drag the corner to resize; click to select. Keyboard: Tab reaches each field;
// arrows move 2pt (Shift 10pt); Alt+arrows resize; Delete / Backspace removes; Escape
// deselects; "Place on page N" adds the armed type without a mouse; Cmd/Ctrl+Z undoes.
// Viewport (P0-1, both hosts): the page column scrolls on its own, the target page follows the
// view, and a field added from the keyboard or in add mode lands where the user is looking.

export interface PlacementCopy {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly centerLabel: string;
  readonly assigneesTitle: string;
  readonly paletteTitle: string;
  readonly assigneeLabel: string;
  readonly inspectorTitle: string;
  readonly noSelection: string;
  readonly unassigned: string;
  readonly prefilledPrefix: string;
  readonly pagesTitle: string;
}

export const DEFAULT_PLACEMENT_COPY: PlacementCopy = {
  leftLabel: 'Fields',
  rightLabel: 'Field properties',
  centerLabel: 'Document pages',
  assigneesTitle: 'Placing for',
  paletteTitle: 'Place a field',
  assigneeLabel: 'Recipient',
  inspectorTitle: 'Field properties',
  noSelection: 'Select a field on the page to edit it. Drag to move; drag the corner handle to resize.',
  unassigned: 'Unassigned',
  prefilledPrefix: 'Prefilled: ',
  pagesTitle: 'Pages',
};

export interface PlacementEditorProps {
  readonly documents: readonly PlacementDocument[];
  readonly renderPage: PageRenderer;
  /** Which catalog surface the palette projects (send_web, template_fixed_form, …). */
  readonly surface: FieldSurface;
  /** P1-6 — offer PAYMENT on a send surface (only when the host can also author its amount). */
  readonly paymentsAvailable?: boolean;
  readonly palette?: { readonly labels?: Partial<Record<FieldTypeKey, string>>; readonly order?: readonly FieldTypeKey[] };
  /** The fields to start from; re-read whenever `resetKey` changes. */
  readonly fields: readonly PlacedField[];
  readonly resetKey: string | number;
  /** Every user edit (not a reset), with the full field set. */
  readonly onChange?: (fields: readonly PlacedField[]) => void;
  readonly assignees: readonly PlacementAssignee[];
  /** A new field may have no assignee (console: "No role"); otherwise placing needs one. */
  readonly allowUnassigned?: boolean;
  readonly prefills?: readonly PlacementPrefill[];
  readonly capabilities: PlacementCapabilities;
  readonly readOnly?: boolean;
  /** The id of a new field of `type`. */
  readonly newFieldId: (type: FieldTypeKey, fields: readonly PlacedField[]) => string;
  /**
   * 'arm' (sign-web): a palette click picks the type, then a click on the page places it, or
   * "Place on page N" places it in view. 'add' (console): a palette click adds it in view.
   */
  readonly paletteMode?: 'arm' | 'add';
  readonly precision?: DragPrecision;
  /** CSS width of a page at 100% zoom: a number, or 'fit' (the column, at most 760px). */
  readonly pageWidth?: number | 'fit';
  /** data-testid / id prefix (the console keeps its `ffs-` ids). */
  readonly idPrefix?: string;
  readonly copy?: Partial<PlacementCopy>;
  /** The host's content above the editor's left-panel sections (console: PDF, tags, roles). */
  readonly leftPanelTop?: ReactNode;
  /** The host's content below the inspector (console: Checks; sign-web: Readiness). */
  readonly rightPanelBottom?: ReactNode;
  /** The host's items at the end of the page toolbar (the save state). */
  readonly toolbarEnd?: ReactNode;
  /** Shown above the pages (errors, loading). */
  readonly status?: ReactNode;
  /** Shown instead of the pages when there are none. */
  readonly empty?: ReactNode;
  /** Size the editor to the window below its own top, leaving `bottomReserve` px (sign-web). */
  readonly fitHeight?: { readonly bottomReserve: number };
  /** Show the field id in the inspector (console: the field_key). */
  readonly showFieldKey?: boolean;
  /** The tag above a field (default: the assignee's label). */
  readonly whoOf?: (a: PlacementAssignee) => string;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;
const FIT_MAX = 760;
const FIT_MIN = 280;
const NARROW = '(max-width: 1100px)';

/** The part of the screen the page column shows: its rect, cut to the window. */
function columnViewRect(el: HTMLElement): ScreenRect | null {
  if (typeof window === 'undefined') return null;
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const top = Math.max(r.top, 0);
  const right = Math.min(r.right, window.innerWidth);
  const bottom = Math.min(r.bottom, window.innerHeight);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

const pageEls = (el: HTMLElement): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('[data-fpe-page]'));

export function PlacementEditor(props: PlacementEditorProps) {
  const {
    documents,
    renderPage,
    surface,
    paymentsAvailable = false,
    palette: paletteOpts,
    fields: initialFields,
    resetKey,
    onChange,
    assignees,
    allowUnassigned = false,
    prefills = [],
    capabilities,
    readOnly = false,
    newFieldId,
    paletteMode = 'arm',
    precision = 'integer',
    pageWidth: pageWidthOpt = 'fit',
    idPrefix: p = 'fpe',
    leftPanelTop,
    rightPanelBottom,
    toolbarEnd,
    status,
    empty,
    fitHeight,
    showFieldKey = false,
    whoOf = (a) => a.label,
  } = props;
  const copy: PlacementCopy = { ...DEFAULT_PLACEMENT_COPY, ...props.copy };

  const slots = useMemo(() => pageSlotsOf(documents), [documents]);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const ctx = useRef<CommandContext>({ pageSize: () => undefined, precision });
  ctx.current = {
    precision,
    pageSize: (ref: PageRef) => slotsRef.current.find((s) => s.docId === ref.docId && s.page === ref.page)?.size,
  };
  const [state, dispatch] = useReducer((s: EditorState, a: EditorAction) => editorReducer(s, a, ctx.current), initialFields, initialEditorState);

  // Re-read the host's fields when it says so (a new envelope / version / PDF). A reset is not
  // an edit: `rev` is kept, so onChange (and the host's autosave) does not fire.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    dispatch({ type: 'reset', fields: initialFields });
    // Only the key decides.
  }, [resetKey]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastRev = useRef(state.rev);
  useEffect(() => {
    if (state.rev === lastRev.current) return;
    lastRev.current = state.rev;
    onChangeRef.current?.(state.fields);
  }, [state.rev, state.fields]);

  const palette = useMemo<PaletteEntry[]>(
    () => paletteFor(surface, { payments_available: paymentsAvailable, ...(paletteOpts?.labels !== undefined ? { labels: paletteOpts.labels } : {}), ...(paletteOpts?.order !== undefined ? { order: paletteOpts.order } : {}) }),
    [surface, paymentsAvailable, paletteOpts?.labels, paletteOpts?.order],
  );
  const typeLabel = useCallback((t: string) => typeLabelOf(t, paletteOpts?.labels), [paletteOpts?.labels]);
  const prefillMap = useMemo(() => new Map(prefills.map((v) => [v.key, v])), [prefills]);

  const [armed, setArmed] = useState<FieldTypeKey | null>(null);
  const [active, setActive] = useState<string | null>(assignees[0]?.id ?? null);
  const [target, setTarget] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [colWidth, setColWidth] = useState(720);
  const [announce, setAnnounce] = useState('');
  const centerRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusField = useRef<string | null>(null);
  const focusColumn = useRef(false);
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; sx: number; sy: number; scale: number } | null>(null);

  // The active assignee stays one of the host's (first by default).
  useEffect(() => {
    if (active !== null && assignees.some((a) => a.id === active)) return;
    setActive(assignees[0]?.id ?? null);
  }, [assignees, active]);

  const selectedId = state.selection[0] ?? null;
  const selected = state.fields.find((f) => f.id === selectedId) ?? null;
  const assigneeOf = useCallback((id: string | null) => assignees.find((a) => a.id === id), [assignees]);
  const canPlace = !readOnly && slots.length > 0 && (allowUnassigned || active !== null);

  // ---- Layout: column width (fit), the window-fitted height, the target page ---------------
  useEffect(() => {
    const el = centerRef.current;
    if (el === null || pageWidthOpt !== 'fit') return undefined;
    const measure = () => setColWidth(el.clientWidth > 0 ? el.clientWidth - 32 : 720);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [pageWidthOpt]);
  const pageWidth = pageWidthOpt === 'fit' ? Math.max(FIT_MIN, Math.min(colWidth, FIT_MAX) * zoom) : pageWidthOpt * zoom;

  const [fitPx, setFitPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (fitHeight === undefined || typeof window === 'undefined') return undefined;
    const measure = () => {
      const el = rootRef.current;
      if (el === null) return;
      if (typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches) {
        setFitPx(null);
        return;
      }
      const top = el.getBoundingClientRect().top + window.scrollY;
      setFitPx(Math.max(420, Math.round(window.innerHeight - top - fitHeight.bottomReserve)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fitHeight?.bottomReserve]);

  // R-2 — as the page column (or, stacked, the window) scrolls, the target page is the page with
  // the largest visible area. A click on a page still selects it.
  useEffect(() => {
    const el = centerRef.current;
    if (el === null || typeof window === 'undefined') return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const vr = columnViewRect(el);
      if (vr === null) return;
      const areas = pageEls(el).map((pg) => visibleArea(pg.getBoundingClientRect(), vr));
      if (areas.length > 0) setTarget((cur) => pickTargetPage(areas, cur));
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  const targetSlot = slots[target] ?? slots[0];

  // Focus management: a new field takes focus (and is scrolled into view if its spot is not
  // visible); after a delete, focus returns to the page column.
  useEffect(() => {
    const id = focusField.current;
    if (id !== null) {
      focusField.current = null;
      const node = centerRef.current?.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(id)}"]`);
      node?.focus({ preventScroll: true });
      node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } else if (focusColumn.current) {
      focusColumn.current = false;
      centerRef.current?.focus({ preventScroll: true });
    }
  }, [state.fields]);

  useEffect(() => {
    if (state.lastUndo !== null) setAnnounce(`Undone: ${state.lastUndo}.`);
  }, [state.past.length, state.lastUndo]);

  // ---- Commands ----------------------------------------------------------------------------
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);

  const place = (type: FieldTypeKey, slot: PageSlot, where: { x: number; y: number } | 'in-view') => {
    const entry = palette.find((t) => t.type === type);
    if (entry === undefined || !canPlace) return;
    let x: number;
    let y: number;
    if (where === 'in-view') {
      const el = centerRef.current;
      const vr = el === null ? null : columnViewRect(el);
      const pageEl = el === null ? undefined : pageEls(el)[slot.index];
      const visible = vr !== null && pageEl !== undefined ? visibleRegionInPage(pageEl.getBoundingClientRect(), vr, slot.size) : null;
      const cascade = state.fields.filter((f) => f.docId === slot.docId && f.page === slot.page).length;
      ({ x, y } = placeNewField({ page: slot.size, visible, size: { width: entry.width, height: entry.height }, cascade }));
    } else {
      // The box centred on the pointer, kept inside the page (top-left frame → PDF-native).
      const b = toPdf(clampBox({ x: where.x - entry.width / 2, y: where.y - entry.height / 2, width: entry.width, height: entry.height }, slot.size), slot.size.height);
      x = b.x;
      y = b.y;
    }
    const f: PlacedField = {
      id: newFieldId(type, state.fields),
      type,
      docId: slot.docId,
      page: slot.page,
      x,
      y,
      width: entry.width,
      height: entry.height,
      required: entry.required,
      assignee: active,
      binding: null,
      settings: DEFAULT_SETTINGS,
    };
    focusField.current = f.id;
    dispatch({ type: 'exec', command: placeField(f, `Add ${entry.label.toLowerCase()} field`) });
    dispatch({ type: 'select', ids: [f.id] });
    setArmed(null);
    setAnnounce(`${entry.label} field added on page ${slot.page + 1}${assigneeOf(active) !== undefined ? ` for ${assigneeOf(active)!.label}` : ''}.`);
  };

  const remove = (f: PlacedField) => {
    focusColumn.current = true;
    dispatch({ type: 'exec', command: removeFields([f.id], `Delete ${typeLabel(f.type).toLowerCase()} field`) });
    dispatch({ type: 'select', ids: [] });
    setAnnounce(`${typeLabel(f.type)} field deleted.`);
  };

  // Global undo shortcut (outside text controls, where Cmd/Ctrl+Z belongs to the control).
  useEffect(() => {
    if (readOnly) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isUndoKey(e) && !isTextControl(e.target)) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, undo]);

  // ---- Pointer gestures --------------------------------------------------------------------
  const onFieldPointerDown = (f: PlacedField, mode: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'select', ids: [f.id] });
    const pageEl = (e.currentTarget as HTMLElement).closest('[data-fpe-page]');
    const slot = slots.find((s) => s.docId === f.docId && s.page === f.page);
    if (pageEl === null || slot === undefined || f.locked === true) return;
    const r = pageEl.getBoundingClientRect();
    drag.current = { id: f.id, mode, sx: e.clientX, sy: e.clientY, scale: r.width > 0 ? slot.size.width / r.width : 1 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dispatch({ type: 'gesture-start' });
  };
  const onFieldPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    dispatch({ type: 'gesture-move', id: d.id, mode: d.mode, dx: (e.clientX - d.sx) * d.scale, dy: (e.clientY - d.sy) * d.scale });
  };
  const onFieldPointerUp = () => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    dispatch({ type: 'gesture-end', label: d.mode === 'move' ? 'Move field' : 'Resize field' });
  };

  const onFieldKey = (f: PlacedField, e: ReactKeyboardEvent<HTMLElement>) => {
    const intent = fieldKeyIntent(e);
    if (intent === null) return;
    switch (intent.kind) {
      case 'move':
        e.preventDefault();
        dispatch({ type: 'exec', command: nudgeFields([f.id], intent.dx, intent.dy) });
        return;
      case 'resize':
        e.preventDefault();
        dispatch({ type: 'exec', command: resizeFields([f.id], intent.dw, intent.dh) });
        return;
      case 'delete':
        e.preventDefault();
        remove(f);
        return;
      case 'deselect':
        dispatch({ type: 'select', ids: [] });
        return;
      case 'select':
        e.preventDefault();
        dispatch({ type: 'select', ids: [f.id] });
        return;
    }
  };

  const faceOf = (f: PlacedField): FieldFace => {
    const face = defaultFace(f, {
      typeLabel,
      assignees,
      prefillLabel: (k) => `${copy.prefilledPrefix}${prefillMap.get(k)?.label ?? k}`,
      unassigned: copy.unassigned,
    });
    const a = assigneeOf(f.assignee);
    return a !== undefined && f.binding === null ? { ...face, who: whoOf(a) } : face;
  };

  // ---- Render ------------------------------------------------------------------------------
  const pageName = (s: PageSlot | undefined): string => (s === undefined ? 'page 1' : documents.length > 1 ? `${s.title}, page ${s.page + 1}` : `page ${s.page + 1}`);
  const hint = readOnly
    ? ''
    : armed !== null
      ? `Click the page to place a ${typeLabel(armed).toLowerCase()} field${assigneeOf(active) !== undefined ? ` for ${assigneeOf(active)!.label}` : ''}.`
      : paletteMode === 'arm'
        ? 'Pick a field type on the left, then click the page. Click a field to edit; drag to move.'
        : 'Pick a field type on the left; it is added to the page in view. Click a field to edit; drag to move.';

  const settingsShown = selected === null ? [] : editableSettingsOf(selected.type, capabilities);
  const canPrefill = selected !== null && (capabilities.prefillTypes ?? []).includes(selected.type) && prefills.length > 0;

  return (
    <div ref={rootRef} className="fpe-root" style={fitPx !== null ? { height: fitPx } : undefined} data-testid={`${p}-editor`}>
      <div className="fpe-body">
        <aside className="fpe-panel" aria-label={copy.leftLabel}>
          {leftPanelTop}
          {readOnly ? null : (
            <>
              {assignees.length > 0 ? (
                <section className="fpe-section">
                  <h2 className="fpe-h">{copy.assigneesTitle}</h2>
                  {assignees.map((a, i) => {
                    const n = state.fields.filter((f) => f.assignee === a.id).length;
                    return (
                      <button key={a.id} type="button" className={a.id === active ? 'fpe-assignee is-on' : 'fpe-assignee'} aria-pressed={a.id === active} onClick={() => setActive(a.id)} data-testid={`${p}-assignee-${a.id}`}>
                        <span className={`fpe-swatch fpe-swatch--tone${(i % 5) + 1}`} style={a.color !== undefined ? { background: a.color } : undefined} aria-hidden="true" />
                        <span className="fpe-ellipsis fpe-assignee__name">{a.label}</span>
                        <span className="fpe-faint">
                          {n} field{n === 1 ? '' : 's'}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ) : null}
              <section className="fpe-section">
                <h2 className="fpe-h">{copy.paletteTitle}</h2>
                <div className="fpe-palette">
                  {palette.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      className={armed === t.type ? 'fpe-tool is-on' : 'fpe-tool'}
                      aria-pressed={paletteMode === 'arm' ? armed === t.type : undefined}
                      disabled={!canPlace}
                      onClick={() => {
                        if (paletteMode === 'add') {
                          if (targetSlot !== undefined) place(t.type, targetSlot, 'in-view');
                        } else setArmed(armed === t.type ? null : t.type);
                      }}
                      data-testid={`${p}-add-${t.type}`}
                    >
                      <span className="fpe-tool__g" aria-hidden="true">
                        {t.glyph}
                      </span>
                      {t.label}
                    </button>
                  ))}
                </div>
                {paletteMode === 'arm' && armed !== null && targetSlot !== undefined ? (
                  <button type="button" className="fpe-btn fpe-btn--block" onClick={() => place(armed, targetSlot, 'in-view')} data-testid={`${p}-place-keyboard`}>
                    Place on {pageName(targetSlot)} (keyboard)
                  </button>
                ) : null}
                <p className="fpe-note" data-testid={`${p}-target`}>
                  Fields are added to {pageName(targetSlot)}. Drag to move; drag the corner to resize.
                </p>
              </section>
            </>
          )}
          {slots.length > 1 ? (
            <section className="fpe-section">
              <h2 className="fpe-h">{copy.pagesTitle}</h2>
              {slots.map((s) => (
                <button
                  key={`${s.docId}:${s.page}`}
                  type="button"
                  className={s.index === targetSlot?.index ? 'fpe-thumb is-on' : 'fpe-thumb'}
                  onClick={() => {
                    setTarget(s.index);
                    document.getElementById(`${p}-pg-${s.docId}-${s.page}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  <span className="fpe-thumb__box" aria-hidden="true" />
                  <span className="fpe-ellipsis fpe-assignee__name">{s.title}</span>
                  <span className="fpe-faint">{s.page + 1}</span>
                </button>
              ))}
            </section>
          ) : null}
        </aside>

        <main ref={centerRef} className="fpe-center" aria-label={copy.centerLabel} data-testid={`${p}-center`} tabIndex={-1}>
          <div className="fpe-toolbar">
            <span className="fpe-toolbar__hint">{hint}</span>
            <button type="button" className="fpe-btn fpe-btn--sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.1) * 10) / 10))}>
              −
            </button>
            <span className="fpe-mono" data-testid={`${p}-zoom`}>
              {Math.round(zoom * 100)}%
            </span>
            <button type="button" className="fpe-btn fpe-btn--sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + 0.1) * 10) / 10))}>
              +
            </button>
            {readOnly ? null : (
              <button type="button" className="fpe-btn fpe-btn--sm" onClick={undo} disabled={state.past.length === 0} data-testid={`${p}-undo`}>
                Undo
              </button>
            )}
            {toolbarEnd}
          </div>
          {status}
          {slots.length === 0 ? (
            empty
          ) : (
            <PlacementPages
              documents={documents}
              renderPage={renderPage}
              fields={state.fields}
              faceOf={faceOf}
              pageWidth={pageWidth}
              idPrefix={p}
              readOnly={readOnly}
              selection={state.selection}
              placing={armed !== null}
              onPagePointer={(slot, point) => {
                setTarget(slot.index);
                if (armed !== null) place(armed, slot, point);
                else dispatch({ type: 'select', ids: [] });
              }}
              onFieldPointerDown={onFieldPointerDown}
              onFieldPointerMove={onFieldPointerMove}
              onFieldPointerUp={onFieldPointerUp}
              onFieldFocus={(f) => dispatch({ type: 'select', ids: [f.id] })}
              onFieldKey={onFieldKey}
            />
          )}
        </main>

        <aside className="fpe-panel fpe-panel--right" aria-label={copy.rightLabel}>
          <section className="fpe-section">
            <h2 className="fpe-h">{copy.inspectorTitle}</h2>
            {selected === null || readOnly ? (
              <p className="fpe-note">{copy.noSelection}</p>
            ) : (
              <div className="fpe-inspector" data-testid={`${p}-inspector`}>
                <p className="fpe-note">
                  <strong>{typeLabel(selected.type)}</strong>
                  {showFieldKey ? (
                    <>
                      {' '}
                      · <code>{selected.id}</code>
                    </>
                  ) : null}{' '}
                  · page {selected.page + 1} · {Math.round(selected.width)} × {Math.round(selected.height)} pt
                </p>
                {selected.locked === true ? (
                  <p className="fpe-note" data-testid={`${p}-field-locked`}>
                    This field type can’t be edited here. It is kept as it is; you can delete it.
                  </p>
                ) : (
                  <>
                    <label className="fpe-row">
                      <span className="fpe-label">{copy.assigneeLabel}</span>
                      <select
                        className="fpe-select"
                        value={selected.binding !== null ? `var:${selected.binding}` : `role:${selected.assignee ?? ''}`}
                        onChange={(e) => {
                          const v = e.target.value;
                          dispatch({ type: 'exec', command: assignField(selected.id, v.startsWith('var:') ? { assignee: null, binding: v.slice(4) } : { assignee: v.slice(5) || null, binding: null }) });
                        }}
                        data-testid={`${p}-assignee-select`}
                      >
                        {selected.assignee === null && selected.binding === null ? <option value="role:">{copy.unassigned}</option> : null}
                        {assignees.map((a) => (
                          <option key={a.id} value={`role:${a.id}`}>
                            {a.label}
                          </option>
                        ))}
                        {canPrefill
                          ? prefills.map((v) => (
                              <option key={v.key} value={`var:${v.key}`}>
                                {copy.prefilledPrefix}
                                {v.label}
                              </option>
                            ))
                          : null}
                      </select>
                    </label>
                    <label className="fpe-check">
                      <input
                        type="checkbox"
                        checked={selected.required}
                        disabled={selected.binding !== null}
                        onChange={(e) => dispatch({ type: 'exec', command: configureField(selected.id, { required: e.target.checked }) })}
                        data-testid={`${p}-required`}
                      />
                      Required
                    </label>
                    {settingsShown.includes('name_mode') ? (
                      <label className="fpe-row">
                        <span className="fpe-label">Name comes from</span>
                        <select
                          className="fpe-select"
                          value={selected.settings.nameMode}
                          onChange={(e) => dispatch({ type: 'exec', command: configureField(selected.id, { nameMode: e.target.value === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : 'SIGNER_PROFILE' }) })}
                          data-testid={`${p}-name-mode`}
                        >
                          <option value="SIGNER_PROFILE">Signer profile (filled by Aramo Sign)</option>
                          <option value="SIGNER_ENTERED">Signer types it</option>
                        </select>
                      </label>
                    ) : null}
                    {settingsShown.includes('label') ? (
                      <label className="fpe-row">
                        <span className="fpe-label">Label</span>
                        <input
                          className="fpe-input"
                          type="text"
                          value={selected.settings.label}
                          maxLength={capabilities.limits?.labelMax}
                          onChange={(e) => dispatch({ type: 'exec', command: configureField(selected.id, { label: e.target.value }) })}
                          data-testid={`${p}-checkbox-label`}
                        />
                      </label>
                    ) : null}
                    {settingsShown.includes('group_key') ? (
                      <label className="fpe-row">
                        <span className="fpe-label">Group</span>
                        <input
                          className="fpe-input"
                          type="text"
                          value={selected.settings.groupKey}
                          maxLength={capabilities.limits?.groupKeyMax}
                          placeholder="No group"
                          onChange={(e) => dispatch({ type: 'exec', command: configureField(selected.id, { groupKey: e.target.value }) })}
                          data-testid={`${p}-checkbox-group`}
                        />
                      </label>
                    ) : null}
                    {settingsShown.includes('group_rule') && selected.settings.groupKey.trim().length > 0 ? (
                      <label className="fpe-row">
                        <span className="fpe-label">Rule</span>
                        <select
                          className="fpe-select"
                          value={selected.settings.groupRule}
                          onChange={(e) => dispatch({ type: 'exec', command: configureField(selected.id, { groupRule: e.target.value === 'SELECT_ONE' ? 'SELECT_ONE' : 'SELECT_ANY' }) })}
                          data-testid={`${p}-checkbox-rule`}
                        >
                          <option value="SELECT_ANY">Select any</option>
                          <option value="SELECT_ONE">Select one</option>
                        </select>
                      </label>
                    ) : null}
                    {settingsShown.includes('min_selected') && selected.settings.groupKey.trim().length > 0 && selected.settings.groupRule === 'SELECT_ANY' ? (
                      <label className="fpe-row">
                        <span className="fpe-label">Minimum checked (when required)</span>
                        <input
                          className="fpe-input"
                          type="number"
                          min={1}
                          max={groupSize(state.fields, selected)}
                          value={selected.settings.minSelected ?? 1}
                          onChange={(e) => {
                            const n = Math.floor(Number(e.target.value));
                            if (Number.isFinite(n) && n >= 1) dispatch({ type: 'exec', command: configureField(selected.id, { minSelected: Math.min(n, groupSize(state.fields, selected)) }) });
                          }}
                          data-testid={`${p}-checkbox-min`}
                        />
                      </label>
                    ) : null}
                  </>
                )}
                <button type="button" className="fpe-btn fpe-btn--danger" onClick={() => remove(selected)} data-testid={`${p}-delete`}>
                  Delete field
                </button>
              </div>
            )}
          </section>
          {rightPanelBottom}
        </aside>
      </div>
      <div className="fpe-sr" role="status" aria-live="polite" data-testid={`${p}-announce`}>
        {announce}
      </div>
    </div>
  );
}
