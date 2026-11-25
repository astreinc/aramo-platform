import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { suggestionReasonText, type FieldSurface, type FieldTypeKey } from '@aramo/sign-fields';

import { PlacementPages, defaultFace, pageSlotsOf, type FieldFace, type PageRenderer, type PageSlot } from './PlacementPages';
import { GRID_STEP, SNAP_DISTANCE_PX, intersects, rectFromPoints, type AlignEdge, type SnapOptions } from './lib/arrange';
import { DUPLICATE_OFFSET, REPEAT_MAX, cloneFields, copyable, repeatCountOf, repeatDown, repeatPitchOf, repeatPitchOfText, type CloneContext } from './lib/clone';
import {
  alignFields,
  assignField,
  assignFields,
  configureField,
  distributeFields,
  editorReducer,
  initialEditorState,
  nudgeFields,
  placeField,
  placeFields,
  removeFields,
  resizeFields,
  sameSizeFields,
  type Command,
  type CommandContext,
  type DragPrecision,
  type EditorAction,
  type EditorState,
} from './lib/editor-state';
import { clampBox, toPdf, toTopLeft, type Box } from './lib/geometry';
import { KEYMAP, editorKeyIntent, fieldKeyIntent, isTextControl } from './lib/keymap';
import {
  defaultSettingsFor,
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
import { radioOptionBelow } from './lib/settings-wire';
import { TRIGGER_TYPES, defaultConditionFor, dependentsOf, previewShownIds, setPreviewAnswer, usableTriggers, triggerChoices } from './lib/conditions';
import { FieldSettingsPanel } from './FieldSettingsPanel';
import { acceptSuggestions, fieldsFromSuggestions, pendingGhosts, type PlacementSuggestion } from './lib/suggestions';
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
//
// Phase 2 (§5 P2-1..P2-3, both hosts): shift-click and drag-a-box multi-select; the selection
// moves, resizes, deletes and is reassigned together; align, distribute, same width / height;
// duplicate, copy / paste (onto the page in view, same position) and Repeat down (N copies of a
// row at a set distance), each ONE undo step; snapping to other fields' edges and an optional
// grid with guides while dragging (Shift turns it off); Redo. Every action is a labelled button
// as well as a key (KEYMAP), and its result is announced.
//
// P2-4 (§5, both hosts) — Suggestions: "Find fields" asks the host for the deterministic
// detector's suggestions; the pending ones (a palette type, not dismissed, not already covered
// by a field) are drawn as dashed ghost fields. Click / Enter accepts one; "Accept all on this
// page" / "Accept all" accept many as ONE undo step; Delete or × dismisses one, "Dismiss all"
// the rest. Accepted ghosts become ordinary fields for the assignee being placed for.
//
// FIELD-PARITY-2 B-7 (both hosts, while the host lists 'condition') — "Show only when…": the
// inspector picks a field's trigger from a list or "Pick the field on the page" (then a click on a
// highlighted field picks it; a click elsewhere or Escape cancels), and the rule. A dashed line
// links each dependent field to its trigger; a dependent is dimmed while the preview answers hide
// it ("Preview answers": a click on a check box or radio option sets its answer; a dropdown's
// answer is chosen in the inspector), by the ONE visibility rule. Deleting a trigger clears its
// dependents' conditions in the same undo step, with a warning.

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
  /**
   * P2-4 — the host's suggestion source (sign-web: the Sign route with detect=all; console: the
   * fixed-form route), already in the editor's frame. Absent: no Suggestions section.
   */
  readonly loadSuggestions?: () => Promise<readonly PlacementSuggestion[]>;
}

const ALIGN_TOOLS: readonly { readonly edge: AlignEdge; readonly label: string; readonly glyph: string }[] = [
  { edge: 'left', label: 'Align left', glyph: '⇤' },
  { edge: 'hcenter', label: 'Align centre', glyph: '↔' },
  { edge: 'right', label: 'Align right', glyph: '⇥' },
  { edge: 'top', label: 'Align top', glyph: '⤒' },
  { edge: 'vcenter', label: 'Align middle', glyph: '↕' },
  { edge: 'bottom', label: 'Align bottom', glyph: '⤓' },
];
const ALIGN_DONE: Readonly<Record<AlignEdge, string>> = { left: 'aligned left', hcenter: 'aligned to the centre', right: 'aligned right', top: 'aligned to the top', vcenter: 'aligned to the middle', bottom: 'aligned to the bottom' };
/** Pointer travel (points) before a press on the page becomes a drag-a-box selection. */
const MARQUEE_MIN = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

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
    loadSuggestions,
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
    setSuggestions(null);
    setDismissed(new Set());
    setPicking(null);
    setAnswers(new Map());
    setConditionNotice(null);
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
  // P2-3 — snapping to other fields' edges (on by default) and the optional grid.
  const [snapOn, setSnapOn] = useState(true);
  const [gridOn, setGridOn] = useState(false);
  // P2-1 — the editor's own clipboard (copies stay inside this editor; the system clipboard is untouched).
  const [clipboard, setClipboard] = useState<readonly PlacedField[]>([]);
  const pasteRound = useRef(0);
  // P2-1 — the Repeat down boxes hold what the sender types (an empty box while retyping, so
  // "delete 1, type 5" gives 5); the number is read when Repeat down runs, and tidied on blur.
  const [repeatCountText, setRepeatCountText] = useState('1');
  // null: follow the suggested row spacing for the selection.
  const [repeatPitchText, setRepeatPitchText] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ slotIndex: number; rect: Box } | null>(null);
  // P2-4 — the loaded suggestions (null: not asked yet), the dismissed ids, the load state.
  const [suggestions, setSuggestions] = useState<readonly PlacementSuggestion[] | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [finding, setFinding] = useState(false);
  // B-7 — picking a trigger on the page (the dependent field's id), the preview answers, the warning.
  const [picking, setPicking] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [conditionNotice, setConditionNotice] = useState<string | null>(null);
  const centerRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusField = useRef<string | null>(null);
  const focusColumn = useRef(false);
  const pointerFocus = useRef(false);
  const drag = useRef<{ id: string; ids: readonly string[]; mode: 'move' | 'resize'; sx: number; sy: number; scale: number } | null>(null);
  const box = useRef<{ slot: PageSlot; start: { x: number; y: number }; additive: boolean; base: readonly string[]; moved: boolean } | null>(null);

  // The active assignee stays one of the host's (first by default).
  useEffect(() => {
    if (active !== null && assignees.some((a) => a.id === active)) return;
    setActive(assignees[0]?.id ?? null);
  }, [assignees, active]);

  const selectedFields = useMemo(() => state.selection.flatMap((id) => state.fields.filter((f) => f.id === id)), [state.selection, state.fields]);
  const selected = selectedFields.length === 1 ? selectedFields[0]! : null;
  const editableSelection = selectedFields.filter(copyable);
  // The Repeat down distance follows the selection until the user sets one.
  const selectionKey = state.selection.join('\u0000');
  // Repeat down moves the selection to its last new row; a spacing the sender typed is kept then,
  // so Repeat down again continues at that spacing.
  const keepPitchOnce = useRef(false);
  useEffect(() => {
    if (keepPitchOnce.current) {
      keepPitchOnce.current = false;
      return;
    }
    setRepeatPitchText(null);
  }, [selectionKey]);
  const assigneeOf = useCallback((id: string | null) => assignees.find((a) => a.id === id), [assignees]);
  const canPlace = !readOnly && slots.length > 0 && (allowUnassigned || active !== null);
  const paletteTypes = useMemo(() => palette.map((t) => t.type as string), [palette]);
  const ghosts = useMemo(
    () => (suggestions === null || readOnly ? [] : pendingGhosts(suggestions, state.fields, { types: paletteTypes, dismissed, pageSize: ctx.current.pageSize })),
    [suggestions, state.fields, paletteTypes, dismissed, readOnly, slots],
  );

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
    else if (state.lastRedo !== null) setAnnounce(`Redone: ${state.lastRedo}.`);
  }, [state.past.length, state.lastUndo, state.lastRedo]);

  // ---- Commands ----------------------------------------------------------------------------
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const cloneCtx: CloneContext = { pageSize: ctx.current.pageSize, precision, newId: (type, fields) => newFieldId(type as FieldTypeKey, fields) };
  const select = (ids: readonly string[]) => dispatch({ type: 'select', ids });
  const lockedNote = (n: number): string => (n > 0 ? ` ${plural(n, 'locked field')} ${n === 1 ? 'was' : 'were'} left out.` : '');

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
      settings: defaultSettingsFor(type, state.fields),
    };
    focusField.current = f.id;
    dispatch({ type: 'exec', command: placeField(f, `Add ${entry.label.toLowerCase()} field`) });
    dispatch({ type: 'select', ids: [f.id] });
    setArmed(null);
    setAnnounce(`${entry.label} field added on page ${slot.page + 1}${assigneeOf(active) !== undefined ? ` for ${assigneeOf(active)!.label}` : ''}.`);
  };

  /**
   * B-7 — the warning when a delete leaves fields without their trigger: their conditions are
   * cleared in the same step (they are always shown from now on); Undo brings both back.
   */
  const orphanNote = (ids: readonly string[]): string => {
    const n = dependentsOf(state.fields, ids).length;
    if (n === 0) {
      setConditionNotice(null);
      return '';
    }
    const text = `${plural(n, 'field')} that showed only for an answer to ${ids.length === 1 ? 'it' : 'them'} ${n === 1 ? 'is' : 'are'} now always shown. Undo brings the condition back.`;
    setConditionNotice(text);
    return ` ${text}`;
  };

  const remove = (f: PlacedField) => {
    focusColumn.current = true;
    const note = orphanNote([f.id]);
    dispatch({ type: 'exec', command: removeFields([f.id], `Delete ${typeLabel(f.type).toLowerCase()} field`) });
    dispatch({ type: 'select', ids: [] });
    setAnnounce(`${typeLabel(f.type)} field deleted.${note}`);
  };

  /** FIELD-PARITY-1 P3 T-5 — "Add option": a sibling radio button below, in the same group (one undo step). */
  const addRadioOption = (f: PlacedField) => {
    const size = ctx.current.pageSize({ docId: f.docId, page: f.page });
    if (size === undefined) return;
    const sibling = radioOptionBelow(state.fields, f, newFieldId('RADIO', state.fields));
    const b = toPdf(clampBox(toTopLeft({ x: sibling.x, y: sibling.y, width: sibling.width, height: sibling.height }, size.height), size), size.height);
    const placed: PlacedField = { ...sibling, x: b.x, y: b.y };
    focusField.current = placed.id;
    dispatch({ type: 'exec', command: placeField(placed, 'Add radio option') });
    dispatch({ type: 'select', ids: [placed.id] });
    setAnnounce(`${placed.settings.label} added to radio group ${f.settings.groupKey}.`);
  };

  /** P2-2 — delete every selected field (a locked field may be deleted). */
  const removeMany = (ids: readonly string[]) => {
    if (ids.length === 1) {
      const f = state.fields.find((x) => x.id === ids[0]);
      if (f !== undefined) remove(f);
      return;
    }
    focusColumn.current = true;
    const note = orphanNote(ids);
    dispatch({ type: 'exec', command: removeFields(ids, `Delete ${ids.length} fields`) });
    dispatch({ type: 'select', ids: [] });
    setAnnounce(`${plural(ids.length, 'field')} deleted.${note}`);
  };

  /** Add copies as one undo step, select them and move focus to the first. */
  /** Place `copies` as one undo step; select `only` when given, else `keep` plus every copy. */
  const addCopies = (copies: readonly PlacedField[], label: string, keep: readonly string[] = [], only?: readonly string[]) => {
    if (copies.length === 0) return;
    const selection = only ?? [...keep, ...copies.map((f) => f.id)];
    focusField.current = selection[0] ?? copies[0]!.id;
    dispatch({ type: 'exec', command: placeFields(copies, label) });
    select(selection);
  };

  /** P2-1 — duplicate the selection, 10pt right and down (Cmd/Ctrl+D). */
  const duplicate = () => {
    if (readOnly) return;
    const copies = cloneFields(state.fields, editableSelection, { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET }, cloneCtx);
    if (copies.length === 0) {
      setAnnounce(selectedFields.length > 0 ? 'Locked fields can’t be duplicated.' : 'Select a field to duplicate.');
      return;
    }
    addCopies(copies, copies.length === 1 ? 'Duplicate field' : `Duplicate ${copies.length} fields`);
    setAnnounce(`${plural(copies.length, 'field')} duplicated.${lockedNote(selectedFields.length - copies.length)}`);
  };

  /** P2-1 — copy the selection into the editor's clipboard (Cmd/Ctrl+C). */
  const copySelection = () => {
    if (readOnly) return;
    if (editableSelection.length === 0) {
      setAnnounce(selectedFields.length > 0 ? 'Locked fields can’t be copied.' : 'Select a field to copy.');
      return;
    }
    setClipboard(editableSelection);
    pasteRound.current = 0;
    setAnnounce(`${plural(editableSelection.length, 'field')} copied.${lockedNote(selectedFields.length - editableSelection.length)}`);
  };

  /**
   * P2-1 — paste onto the page in view at the same position (Cmd/Ctrl+V). Pasting back onto the
   * page the copies came from steps each paste 10pt right and down, so copies never stack.
   */
  const paste = () => {
    if (readOnly || clipboard.length === 0 || targetSlot === undefined) return;
    const ref = { docId: targetSlot.docId, page: targetSlot.page };
    const samePage = clipboard.every((f) => f.docId === ref.docId && f.page === ref.page);
    const step = samePage ? (pasteRound.current += 1) * DUPLICATE_OFFSET : 0;
    const copies = cloneFields(state.fields, clipboard, { dx: step, dy: step, target: ref }, cloneCtx);
    addCopies(copies, copies.length === 1 ? 'Paste field' : `Paste ${copies.length} fields`);
    setAnnounce(`${plural(copies.length, 'field')} pasted on ${pageName(targetSlot)}.`);
  };

  /** P2-1 — Repeat down: N copies of the selected row, each `pitch` points below the last. */
  const defaultPitch = repeatPitchOf(editableSelection, cloneCtx.pageSize);
  const repeatCount = repeatCountOf(repeatCountText);
  const typedPitch = repeatPitchText === null ? null : repeatPitchOfText(repeatPitchText);
  const pitch = typedPitch ?? defaultPitch ?? 0;
  const runRepeat = () => {
    if (readOnly) return;
    if (repeatCount === null) {
      setAnnounce(`Enter how many copies to add (1 to ${REPEAT_MAX}).`);
      return;
    }
    if (repeatPitchText !== null && typedPitch === null) {
      setAnnounce('Enter the row spacing in points (more than 0).');
      return;
    }
    const r = repeatDown(state.fields, editableSelection, { count: repeatCount, pitch, ...(capabilities.limits?.groupKeyMax !== undefined ? { groupKeyMax: capabilities.limits.groupKeyMax } : {}) }, cloneCtx);
    if (!r.ok) {
      setAnnounce(r.reason === 'pages' ? 'Repeat down works on fields on one page. Select one row.' : 'Select a field or row to repeat.');
      return;
    }
    if (r.rows === 0) {
      setAnnounce('No rows added: there is no room below the row on this page.');
      return;
    }
    // Only the last new row stays selected, so Repeat down again continues the column at the
    // same spacing (selecting the whole column made the next click repeat the column: 2, 4, 8).
    const rowSize = r.fields.length / r.rows;
    keepPitchOnce.current = repeatPitchText !== null;
    addCopies(r.fields, `Repeat down ${plural(r.rows, 'row')}`, [], r.fields.slice(-rowSize).map((f) => f.id));
    setAnnounce(`${plural(r.rows, 'row')} added.${r.skipped > 0 ? ` ${plural(r.skipped, 'row')} did not fit on the page.` : ''}`);
  };

  /** P2-2 — align / distribute / same size, as one undo step, announced. */
  const arrange = (make: (ids: readonly string[]) => Command, done: string) => {
    // The selection's order is kept, so its first editable field is the anchor (same width / height).
    const ids = editableSelection.map((f) => f.id);
    dispatch({ type: 'exec', command: make(ids) });
    setAnnounce(`${plural(ids.length, 'field')} ${done}.`);
  };

  // ---- P2-4 suggestions -------------------------------------------------------------------
  const findFields = async () => {
    if (loadSuggestions === undefined || finding) return;
    setFinding(true);
    setAnnounce('Looking for fields…');
    try {
      const list = await loadSuggestions();
      setSuggestions(list);
      setDismissed(new Set());
      const n = pendingGhosts(list, state.fields, { types: paletteTypes, dismissed: new Set(), pageSize: ctx.current.pageSize }).length;
      setAnnounce(n === 0 ? 'No fields found to suggest.' : `${plural(n, 'suggested field')} shown as dashed boxes. Click one to add it.`);
    } catch {
      setSuggestions([]);
      setAnnounce('Suggestions are not available right now.');
    } finally {
      setFinding(false);
    }
  };

  /** Accept suggestions as ONE undo step; the new fields are selected. */
  const accept = (list: readonly PlacementSuggestion[], what: string) => {
    if (readOnly || list.length === 0) return;
    if (!canPlace) {
      setAnnounce('Add someone to fill the fields first: a suggested field needs someone to fill it.');
      return;
    }
    const added = fieldsFromSuggestions(list, { assignee: active, fields: state.fields, newId: (type, fields) => newFieldId(type as FieldTypeKey, fields), pageSize: ctx.current.pageSize });
    if (added.length === 0) return;
    focusField.current = added.length === 1 ? added[0]!.id : null;
    dispatch({ type: 'exec', command: acceptSuggestions(added, added.length === 1 ? `Add suggested ${typeLabel(added[0]!.type).toLowerCase()} field` : `Accept ${added.length} suggested fields`) });
    select(added.map((f) => f.id));
    const who = assigneeOf(active);
    setAnnounce(`${what}: ${plural(added.length, 'field')} added${who !== undefined ? ` for ${who.label}` : ''}.`);
  };
  const dismiss = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    setDismissed((d) => new Set([...d, ...ids]));
    setAnnounce(ids.length === 1 ? 'Suggestion dismissed.' : `${plural(ids.length, 'suggestion')} dismissed.`);
    if (ids.length === 1) focusColumn.current = true;
  };
  const ghostsOnTarget = targetSlot === undefined ? [] : ghosts.filter((g) => g.docId === targetSlot.docId && g.page === targetSlot.page);

  /** Cmd/Ctrl+A — every visible field on the page of the selection (else the page in view). */
  const selectAllOnPage = () => {
    const anchor = selectedFields[0];
    const ref = anchor !== undefined ? { docId: anchor.docId, page: anchor.page } : targetSlot === undefined ? null : { docId: targetSlot.docId, page: targetSlot.page };
    if (ref === null) return;
    const ids = state.fields.filter((f) => f.docId === ref.docId && f.page === ref.page && f.hidden !== true).map((f) => f.id);
    select(ids);
    setAnnounce(`${plural(ids.length, 'field')} selected.`);
  };

  // Editor-wide shortcuts. Undo / redo work anywhere outside a text control (where the keys belong
  // to the control); duplicate, copy, paste and select-all only while focus is in the editor (or
  // on nothing), so the host's own page keeps its Cmd/Ctrl+C.
  const keyActions = useRef({ duplicate, copySelection, paste, selectAllOnPage });
  keyActions.current = { duplicate, copySelection, paste, selectAllOnPage };
  useEffect(() => {
    if (readOnly) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const intent = editorKeyIntent(e);
      if (intent === null || isTextControl(e.target)) return;
      if (intent === 'undo' || intent === 'redo') {
        e.preventDefault();
        if (intent === 'undo') undo();
        else redo();
        return;
      }
      const t = e.target;
      // On the bare page (focus on <body>) the keys are the editor's only while no text is
      // selected, so copying text the user highlighted still works.
      const textSelected = (window.getSelection?.()?.toString() ?? '').length > 0;
      const inside = t instanceof Node && (rootRef.current?.contains(t) === true || (t === document.body && !textSelected));
      if (!inside) return;
      e.preventDefault();
      const a = keyActions.current;
      if (intent === 'duplicate') a.duplicate();
      else if (intent === 'copy') a.copySelection();
      else if (intent === 'paste') a.paste();
      else a.selectAllOnPage();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, undo, redo]);

  // ---- Pointer gestures --------------------------------------------------------------------
  /** Add or remove one field from the selection (Shift+click, Shift+Enter / Space). */
  const toggle = (f: PlacedField) => {
    const on = state.selection.includes(f.id);
    const ids = on ? state.selection.filter((id) => id !== f.id) : [...state.selection, f.id];
    select(ids);
    setAnnounce(`${typeLabel(f.type)} field ${on ? 'removed from' : 'added to'} the selection; ${plural(ids.length, 'field')} selected.`);
  };

  const onFieldPointerDown = (f: PlacedField, mode: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    pointerFocus.current = true;
    // B-7 — picking a trigger: a click on a field the rule accepts sets it; any other cancels.
    if (picking !== null) {
      pickTrigger(f);
      return;
    }
    // B-7 — preview answers: a click on a check box or radio option sets its answer.
    if (previewOn && mode === 'move' && !e.shiftKey && TRIGGER_TYPES.has(f.type) && f.type !== 'DROPDOWN') {
      setAnswers((a) => setPreviewAnswer(a, state.fields, f));
      select([f.id]);
      return;
    }
    if (mode === 'move' && e.shiftKey) {
      toggle(f);
      return;
    }
    // Pressing a field of a multi-selection drags the whole selection; any other field is selected alone.
    const ids = state.selection.includes(f.id) ? state.selection : [f.id];
    if (ids !== state.selection) select(ids);
    const pageEl = (e.currentTarget as HTMLElement).closest('[data-fpe-page]');
    const slot = slots.find((s) => s.docId === f.docId && s.page === f.page);
    if (pageEl === null || slot === undefined || f.locked === true) return;
    const r = pageEl.getBoundingClientRect();
    drag.current = { id: f.id, ids, mode, sx: e.clientX, sy: e.clientY, scale: r.width > 0 ? slot.size.width / r.width : 1 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dispatch({ type: 'gesture-start' });
  };
  const onFieldPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    // P2-3 — snap to other fields' edges and / or the grid; Shift turns snapping off for the drag.
    const snap: SnapOptions | null = e.shiftKey || (!snapOn && !gridOn) ? null : { edges: snapOn, grid: gridOn ? GRID_STEP : null, threshold: SNAP_DISTANCE_PX * d.scale };
    dispatch({ type: 'gesture-move', id: d.id, ids: d.ids, mode: d.mode, dx: (e.clientX - d.sx) * d.scale, dy: (e.clientY - d.sy) * d.scale, snap });
  };
  const onFieldPointerUp = () => {
    pointerFocus.current = false;
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    const n = d.ids.length;
    dispatch({ type: 'gesture-end', label: d.mode === 'move' ? (n > 1 ? `Move ${n} fields` : 'Move field') : n > 1 ? `Resize ${n} fields` : 'Resize field' });
  };

  const onFieldKey = (f: PlacedField, e: ReactKeyboardEvent<HTMLElement>) => {
    const intent = fieldKeyIntent(e);
    if (intent === null) return;
    // A key on a field of the selection acts on the whole selection.
    const ids = state.selection.includes(f.id) ? state.selection : [f.id];
    const many = ids.length > 1;
    switch (intent.kind) {
      case 'move':
        e.preventDefault();
        dispatch({ type: 'exec', command: nudgeFields(ids, intent.dx, intent.dy, many ? `Move ${ids.length} fields` : 'Move field') });
        return;
      case 'resize':
        e.preventDefault();
        dispatch({ type: 'exec', command: resizeFields(ids, intent.dw, intent.dh, many ? `Resize ${ids.length} fields` : 'Resize field') });
        return;
      case 'delete':
        e.preventDefault();
        removeMany(ids);
        return;
      case 'deselect':
        if (picking !== null) {
          setPicking(null);
          setAnnounce('Picking cancelled.');
          return;
        }
        select([]);
        return;
      case 'select':
        e.preventDefault();
        select([f.id]);
        return;
      case 'toggle':
        e.preventDefault();
        toggle(f);
        return;
    }
  };

  // P2-2 — drag-a-box selection on a page's background (Shift adds to the selection).
  const onPagePointer = (slot: PageSlot, point: { x: number; y: number }, e: ReactPointerEvent<HTMLElement>) => {
    setTarget(slot.index);
    if (picking !== null) {
      setPicking(null);
      setAnnounce('Picking cancelled.');
      return;
    }
    if (armed !== null) {
      place(armed, slot, point);
      return;
    }
    if (!e.shiftKey) select([]);
    if (readOnly) return;
    box.current = { slot, start: point, additive: e.shiftKey, base: e.shiftKey ? state.selection : [], moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPagePointerMove = (slot: PageSlot, point: { x: number; y: number }) => {
    const b = box.current;
    if (b === null || b.slot.index !== slot.index) return;
    if (!b.moved && Math.hypot(point.x - b.start.x, point.y - b.start.y) < MARQUEE_MIN) return;
    b.moved = true;
    setMarquee({ slotIndex: slot.index, rect: rectFromPoints(b.start, point) });
  };
  const onPagePointerUp = (slot: PageSlot, point: { x: number; y: number }) => {
    const b = box.current;
    box.current = null;
    setMarquee(null);
    if (b === null || !b.moved || b.slot.index !== slot.index) return;
    const rect = rectFromPoints(b.start, point);
    const hit = state.fields
      .filter((f) => f.docId === slot.docId && f.page === slot.page && f.hidden !== true && intersects(toTopLeft({ x: f.x, y: f.y, width: f.width, height: f.height }, slot.size.height), rect))
      .map((f) => f.id);
    const ids = [...b.base, ...hit.filter((id) => !b.base.includes(id))];
    select(ids);
    setAnnounce(`${plural(ids.length, 'field')} selected.`);
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
  const describe = (f: PlacedField): string => {
    const label = f.settings.label.trim();
    const slot = slots.find((x) => x.docId === f.docId && x.page === f.page);
    return `${typeLabel(f.type)}${label.length > 0 ? ` “${label}”` : ''} · ${pageName(slot)}`;
  };

  // ---- B-7 conditions ------------------------------------------------------------------------
  const conditionsOn = !readOnly && capabilities.settings.includes('condition');
  const pickable = useMemo(() => (picking === null ? null : new Set(usableTriggers(state.fields, picking).map((f) => f.id))), [picking, state.fields]);
  /** Set `picking`'s trigger to `t` (an offered trigger), as one undo step. */
  const pickTrigger = (t: PlacedField) => {
    const dependent = picking;
    setPicking(null);
    if (dependent === null) return;
    const condition = pickable?.has(t.id) === true ? defaultConditionFor(t) : null;
    if (condition === null) {
      setAnnounce('That field can’t show or hide this one. Picking cancelled.');
      return;
    }
    dispatch({ type: 'exec', command: configureField(dependent, { condition }, 'Set when the field is shown') });
    select([dependent]);
    setAnnounce(`This field now shows only when ${describe(t)} is answered.`);
  };
  const previewShown = useMemo(() => previewShownIds(state.fields, answers), [state.fields, answers]);
  // Preview answers only means something with a "Show only when" field: without one the button is
  // not offered (it showed no change at all, field test 2026-11-25).
  const hasConditions = state.fields.some((f) => f.settings.condition !== null);
  const dimmed = useMemo(() => new Set(state.fields.filter((f) => f.settings.condition !== null && !previewShown.has(f.id)).map((f) => f.id)), [state.fields, previewShown]);
  const links = useMemo(
    () =>
      state.fields.flatMap((f) => {
        const c = f.settings.condition;
        return c === null ? [] : [{ from: f.id, to: c.trigger_key, active: state.selection.includes(f.id) || state.selection.includes(c.trigger_key) }];
      }),
    [state.fields, state.selection],
  );
  const triggerOnOtherPage = (f: PlacedField): string | null => {
    const c = f.settings.condition;
    const t = c === null ? undefined : state.fields.find((x) => x.id === c.trigger_key);
    return t !== undefined && (t.docId !== f.docId || t.page !== f.page) ? describe(t) : null;
  };
  const canPrefill = selected !== null && (capabilities.prefillTypes ?? []).includes(selected.type) && prefills.length > 0;

  // P2-1 — duplicate, copy and Repeat down for the selection (one field or many).
  const onOnePage = editableSelection.length > 0 && editableSelection.every((f) => f.docId === editableSelection[0]!.docId && f.page === editableSelection[0]!.page);
  const selectionTools =
    editableSelection.length === 0 ? null : (
      <div className="fpe-row" data-testid={`${p}-selection-tools`}>
        <div className="fpe-tools fpe-tools--2">
          <button type="button" className="fpe-btn" onClick={duplicate} title="Duplicate (Cmd/Ctrl+D)" data-testid={`${p}-duplicate`}>
            Duplicate
          </button>
          <button type="button" className="fpe-btn" onClick={copySelection} title="Copy (Cmd/Ctrl+C)" data-testid={`${p}-copy`}>
            Copy
          </button>
        </div>
        {onOnePage ? (
          <fieldset className="fpe-row" style={{ border: 0, padding: 0, margin: '6px 0 0' }}>
            <legend className="fpe-label">Repeat down (table rows)</legend>
            <div className="fpe-inline">
              <label className="fpe-row">
                <span className="fpe-label">Copies</span>
                <input
                  className="fpe-input"
                  type="number"
                  min={1}
                  max={REPEAT_MAX}
                  value={repeatCountText}
                  onChange={(e) => setRepeatCountText(e.target.value)}
                  onBlur={() => setRepeatCountText(String(repeatCount ?? 1))}
                  data-testid={`${p}-repeat-count`}
                />
              </label>
              <label className="fpe-row">
                <span className="fpe-label">Row spacing (pt, top to top)</span>
                <input
                  className="fpe-input"
                  type="number"
                  min={1}
                  step={1}
                  value={repeatPitchText ?? String(defaultPitch ?? 0)}
                  onChange={(e) => setRepeatPitchText(e.target.value)}
                  onBlur={() => {
                    // A box left empty or not a spacing goes back to the suggested spacing.
                    if (repeatPitchText !== null && typedPitch === null) setRepeatPitchText(null);
                  }}
                  data-testid={`${p}-repeat-pitch`}
                />
              </label>
            </div>
            <button type="button" className="fpe-btn fpe-btn--block" onClick={runRepeat} data-testid={`${p}-repeat`}>
              Repeat down
            </button>
          </fieldset>
        ) : null}
      </div>
    );

  // P2-2 — the inspector for two or more fields: reassign, arrange, copy, delete together.
  const assignedTo = new Set(editableSelection.map((f) => (f.binding !== null ? `var:${f.binding}` : `role:${f.assignee ?? ''}`)));
  // One shared recipient / role is shown; a mix (or a prefill binding) shows "Mixed".
  const only = assignedTo.size === 1 ? [...assignedTo][0]! : '';
  const commonAssignee = only.startsWith('role:') ? only : '';
  const lockedCount = selectedFields.length - editableSelection.length;
  const multiInspector = (
    <div className="fpe-inspector" data-testid={`${p}-multi-inspector`}>
      <p className="fpe-note" data-testid={`${p}-selection-count`}>
        <strong>{plural(selectedFields.length, 'field')} selected</strong>
        {lockedCount > 0 ? ` · ${plural(lockedCount, 'locked field')} kept as ${lockedCount === 1 ? 'it is' : 'they are'}` : ''}
      </p>
      {editableSelection.length > 0 && assignees.length > 0 ? (
        <label className="fpe-row">
          <span className="fpe-label">{copy.assigneeLabel}</span>
          <select
            className="fpe-select"
            value={commonAssignee}
            onChange={(e) => {
              const v = e.target.value;
              if (!v.startsWith('role:')) return;
              const to = v.slice(5) || null;
              dispatch({ type: 'exec', command: assignFields(editableSelection.map((f) => f.id), { assignee: to, binding: null }, `Reassign ${editableSelection.length} fields`) });
              setAnnounce(`${plural(editableSelection.length, 'field')} now for ${assigneeOf(to)?.label ?? copy.unassigned}.`);
            }}
            data-testid={`${p}-multi-assignee`}
          >
            {commonAssignee === '' ? <option value="">Mixed</option> : null}
            {commonAssignee === 'role:' || allowUnassigned ? <option value="role:">{copy.unassigned}</option> : null}
            {assignees.map((a) => (
              <option key={a.id} value={`role:${a.id}`}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {editableSelection.length > 1 ? (
        <div className="fpe-row" role="group" aria-label="Arrange">
          <span className="fpe-label">Align</span>
          <div className="fpe-tools">
            {ALIGN_TOOLS.map((t) => (
              <button key={t.edge} type="button" className="fpe-btn" aria-label={t.label} title={t.label} onClick={() => arrange((ids) => alignFields(ids, t.edge), ALIGN_DONE[t.edge])} data-testid={`${p}-align-${t.edge}`}>
                <span aria-hidden="true">{t.glyph}</span> {t.label.replace('Align ', '')}
              </button>
            ))}
          </div>
          <span className="fpe-label">Distribute and size</span>
          <div className="fpe-tools fpe-tools--2">
            <button
              type="button"
              className="fpe-btn"
              disabled={editableSelection.length < 3}
              onClick={() => arrange((ids) => distributeFields(ids, 'horizontal'), 'distributed horizontally')}
              data-testid={`${p}-distribute-horizontal`}
            >
              Distribute across
            </button>
            <button
              type="button"
              className="fpe-btn"
              disabled={editableSelection.length < 3}
              onClick={() => arrange((ids) => distributeFields(ids, 'vertical'), 'distributed vertically')}
              data-testid={`${p}-distribute-vertical`}
            >
              Distribute down
            </button>
            <button type="button" className="fpe-btn" onClick={() => arrange((ids) => sameSizeFields(ids, 'width'), 'given the same width')} data-testid={`${p}-same-width`}>
              Same width
            </button>
            <button type="button" className="fpe-btn" onClick={() => arrange((ids) => sameSizeFields(ids, 'height'), 'given the same height')} data-testid={`${p}-same-height`}>
              Same height
            </button>
          </div>
          <p className="fpe-faint">Same width and height copy the first field you selected.</p>
        </div>
      ) : null}
      {selectionTools}
      <button type="button" className="fpe-btn fpe-btn--danger" onClick={() => removeMany(state.selection)} data-testid={`${p}-delete-many`}>
        Delete {plural(selectedFields.length, 'field')}
      </button>
    </div>
  );

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
              {loadSuggestions !== undefined ? (
                <section className="fpe-section" aria-label="Suggested fields" data-testid={`${p}-suggestions`}>
                  <h2 className="fpe-h">Suggestions</h2>
                  <button type="button" className="fpe-btn fpe-btn--block" onClick={() => void findFields()} disabled={finding || slots.length === 0} data-testid={`${p}-find-fields`}>
                    {finding ? 'Looking for fields…' : suggestions === null ? 'Find fields' : 'Find fields again'}
                  </button>
                  {suggestions !== null && !finding ? (
                    ghosts.length === 0 ? (
                      <p className="fpe-note" data-testid={`${p}-suggestions-none`}>
                        {suggestions.length === 0 ? 'No fields found. Place them from the list above.' : 'No suggestions left.'}
                      </p>
                    ) : (
                      <>
                        <p className="fpe-note" data-testid={`${p}-suggestions-count`}>
                          {plural(ghosts.length, 'suggested field')} (dashed). Click one, or press Enter on it, to add it; Delete dismisses it.
                          {assigneeOf(active) !== undefined ? ` Added fields are for ${assigneeOf(active)!.label}.` : ''}
                        </p>
                        <div className="fpe-tools fpe-tools--2">
                          <button type="button" className="fpe-btn" disabled={ghostsOnTarget.length === 0 || !canPlace} onClick={() => accept(ghostsOnTarget, `Accepted on ${pageName(targetSlot)}`)} data-testid={`${p}-accept-page`}>
                            Accept all on {pageName(targetSlot)}
                          </button>
                          <button type="button" className="fpe-btn" disabled={!canPlace} onClick={() => accept(ghosts, 'Accepted every suggestion')} data-testid={`${p}-accept-all`}>
                            Accept all ({ghosts.length})
                          </button>
                        </div>
                        <button type="button" className="fpe-btn fpe-btn--block" onClick={() => dismiss(ghosts.map((g) => g.id))} data-testid={`${p}-dismiss-all`}>
                          Dismiss all
                        </button>
                      </>
                    )
                  ) : null}
                </section>
              ) : null}
              <section className="fpe-section">
                <details data-testid={`${p}-keymap`}>
                  <summary className="fpe-h">Keyboard shortcuts</summary>
                  <dl className="fpe-keys">
                    {KEYMAP.map((k) => (
                      <div key={k.keys} style={{ display: 'contents' }}>
                        <dt>{k.keys}</dt>
                        <dd>{k.action}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
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
              <>
                <button type="button" className="fpe-btn fpe-btn--sm" onClick={undo} disabled={state.past.length === 0} data-testid={`${p}-undo`} title="Undo (Cmd/Ctrl+Z)">
                  Undo
                </button>
                <button type="button" className="fpe-btn fpe-btn--sm" onClick={redo} disabled={state.future.length === 0} data-testid={`${p}-redo`} title="Redo (Shift+Cmd/Ctrl+Z)">
                  Redo
                </button>
                <button
                  type="button"
                  className="fpe-btn fpe-btn--sm"
                  onClick={paste}
                  disabled={clipboard.length === 0 || targetSlot === undefined}
                  aria-label={`Paste ${plural(clipboard.length, 'copied field')} onto ${pageName(targetSlot)}`}
                  title="Paste (Cmd/Ctrl+V)"
                  data-testid={`${p}-paste`}
                >
                  Paste
                </button>
                <button
                  type="button"
                  className={snapOn ? 'fpe-btn fpe-btn--sm is-on' : 'fpe-btn fpe-btn--sm'}
                  aria-pressed={snapOn}
                  onClick={() => setSnapOn((v) => !v)}
                  title="Snap to other fields while dragging (hold Shift to turn it off for one drag)"
                  data-testid={`${p}-snap`}
                >
                  Snap
                </button>
                <button
                  type="button"
                  className={gridOn ? 'fpe-btn fpe-btn--sm is-on' : 'fpe-btn fpe-btn--sm'}
                  aria-pressed={gridOn}
                  onClick={() => setGridOn((v) => !v)}
                  title={`Show a ${GRID_STEP}pt grid and snap to it`}
                  data-testid={`${p}-grid`}
                >
                  Grid
                </button>
                {conditionsOn && (hasConditions || previewOn) ? (
                  <button
                    type="button"
                    className={previewOn ? 'fpe-btn fpe-btn--sm is-on' : 'fpe-btn fpe-btn--sm'}
                    aria-pressed={previewOn}
                    onClick={() => {
                      const on = !previewOn;
                      setPreviewOn(on);
                      if (!on) setAnswers(new Map());
                      setAnnounce(on ? 'Preview answers: click a check box or radio option to answer it; fields hidden by the answers are dimmed.' : 'Preview answers cleared.');
                    }}
                    title="Try answers to see which fields show (nothing is saved)"
                    data-testid={`${p}-preview`}
                  >
                    Preview answers
                  </button>
                ) : null}
              </>
            )}
            {toolbarEnd}
          </div>
          {status}
          {conditionNotice !== null ? (
            <div className="fpe-note fpe-note--warn" role="status" data-testid={`${p}-condition-notice`}>
              <span>{conditionNotice}</span>
              <button type="button" className="fpe-btn fpe-btn--sm" onClick={() => setConditionNotice(null)} aria-label="Dismiss" data-testid={`${p}-condition-notice-dismiss`}>
                ×
              </button>
            </div>
          ) : null}
          {previewOn ? (
            // Field test 2026-11-25 — the preview only answered screen readers; the sender saw no
            // change and did not know what to do. It now says so on screen while it is on.
            <p className="fpe-note" role="status" data-testid={`${p}-preview-note`}>
              Preview answers: click a check box or radio option (or pick a dropdown answer in its settings) to see which
              fields show. Fields hidden by these answers are dimmed. Nothing is saved.
            </p>
          ) : null}
          {picking !== null ? (
            <p className="fpe-note" role="status" data-testid={`${p}-picking`}>
              Click the field this one depends on (highlighted). Press Escape or click the page to cancel.
            </p>
          ) : null}
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
              onPagePointer={onPagePointer}
              onPagePointerMove={onPagePointerMove}
              onPagePointerUp={onPagePointerUp}
              marquee={marquee}
              guides={state.guides}
              grid={gridOn ? GRID_STEP : null}
              onFieldPointerDown={onFieldPointerDown}
              onFieldPointerMove={onFieldPointerMove}
              onFieldPointerUp={onFieldPointerUp}
              onFieldFocus={(f) => {
                // A press already chose the selection; keyboard focus on a field outside the selection selects it alone.
                if (pointerFocus.current) {
                  pointerFocus.current = false;
                  return;
                }
                if (!state.selection.includes(f.id)) select([f.id]);
              }}
              onFieldKey={onFieldKey}
              ghosts={ghosts}
              ghostLabel={(g) => `Suggested ${typeLabel(g.type).toLowerCase()} field ${suggestionReasonText(g.reason)}`}
              onGhostAccept={(g) => accept([g], 'Suggestion accepted')}
              onGhostDismiss={(g) => dismiss([g.id])}
              dimmed={dimmed}
              pickable={pickable}
              links={links}
            />
          )}
        </main>

        <aside className="fpe-panel fpe-panel--right" aria-label={copy.rightLabel}>
          <section className="fpe-section">
            <h2 className="fpe-h">{copy.inspectorTitle}</h2>
            {selectedFields.length === 0 || readOnly ? (
              <p className="fpe-note">{copy.noSelection}</p>
            ) : selected === null ? (
              multiInspector
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
                    <FieldSettingsPanel
                      field={selected}
                      fields={state.fields}
                      shown={conditionsOn ? settingsShown : settingsShown.filter((k) => k !== 'condition')}
                      capabilities={capabilities}
                      idPrefix={p}
                      onChange={(patch) => dispatch({ type: 'exec', command: configureField(selected.id, patch) })}
                      onAddRadioOption={() => addRadioOption(selected)}
                      describe={describe}
                      picking={picking === selected.id}
                      onPickTrigger={() => {
                        const on = picking !== selected.id;
                        setPicking(on ? selected.id : null);
                        setAnnounce(on ? 'Click the field this one depends on. Escape cancels.' : 'Picking cancelled.');
                      }}
                    />
                    {conditionsOn && triggerOnOtherPage(selected) !== null ? (
                      <p className="fpe-faint" data-testid={`${p}-condition-elsewhere`}>
                        Its trigger is on another page: {triggerOnOtherPage(selected)}.
                      </p>
                    ) : null}
                    {conditionsOn && previewOn && TRIGGER_TYPES.has(selected.type) ? <PreviewAnswer field={selected} answers={answers} idPrefix={p} onAnswer={(v) => setAnswers((a) => setPreviewAnswer(a, state.fields, selected, v))} /> : null}
                  </>
                )}
                {selectionTools}
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

/** B-7 — the preview answer of a trigger field (not saved; it only decides which fields are dimmed). */
function PreviewAnswer({ field, answers, idPrefix: p, onAnswer }: { readonly field: PlacedField; readonly answers: ReadonlyMap<string, string>; readonly idPrefix: string; readonly onAnswer: (v: string) => void }) {
  const v = answers.get(field.id) ?? '';
  if (field.type === 'DROPDOWN') {
    return (
      <label className="fpe-row">
        <span className="fpe-label">Preview answer</span>
        <select className="fpe-select" value={v} onChange={(e) => onAnswer(e.target.value)} data-testid={`${p}-preview-answer`}>
          <option value="">No answer</option>
          {triggerChoices(field).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="fpe-check">
      <input type="checkbox" checked={v === 'true'} onChange={(e) => onAnswer(e.target.checked ? 'true' : 'false')} data-testid={`${p}-preview-answer`} />
      Preview answer: {field.type === 'RADIO' ? 'this option is chosen' : 'checked'}
    </label>
  );
}
