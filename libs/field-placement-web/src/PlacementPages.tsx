import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { toTopLeft, type Box, type PdfPageInfo } from './lib/geometry';
import { type PlacedField, type PlacementAssignee, type PlacementDocument } from './lib/model';
import './field-placement.css';

// FIELD-PARITY-1 P1-5 — the page column of the shared placement editor: each document's pages
// rendered by the host's renderer, with the placed fields drawn over them. Editable inside
// PlacementEditor; read-only (no roles, no tab stops) for a preview such as the console's
// fixed-form preview.
//
// P2 (§5 P2-2 / P2-3) — overlays drawn above the page and under the fields, never taking the
// pointer: the drag-a-box rectangle, the alignment guides of a drag, and the optional grid.

/** Renders one page into a canvas at a CSS width (the host's pdf.js loader). */
export type PageRenderer = (docId: string, pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number) => Promise<void>;

export interface PageSlot {
  readonly docId: string;
  readonly title: string;
  readonly page: number;
  readonly size: PdfPageInfo;
  /** The page's position across every document (0-based). */
  readonly index: number;
}

export function pageSlotsOf(documents: readonly PlacementDocument[]): PageSlot[] {
  const out: PageSlot[] = [];
  for (const d of documents) d.pages.forEach((size, page) => out.push({ docId: d.id, title: d.title, page, size, index: out.length }));
  return out;
}

export interface FieldFace {
  /** The visible text in the box ('' for a checkbox). */
  readonly text: string;
  /** The tag above the box (who fills it); null for none. */
  readonly who: string | null;
  readonly ariaLabel: string;
  /** Tone 0..5 (0: neutral / prefilled) unless `color` is set. */
  readonly tone: number;
  readonly color?: string;
}

export interface PlacementPagesProps {
  readonly documents: readonly PlacementDocument[];
  readonly renderPage: PageRenderer;
  readonly fields: readonly PlacedField[];
  readonly faceOf: (f: PlacedField) => FieldFace;
  /** CSS width of a rendered page (px). */
  readonly pageWidth: number;
  readonly idPrefix: string;
  readonly readOnly: boolean;
  readonly selection?: readonly string[];
  /** A type is armed: a click on the page places it. */
  readonly placing?: boolean;
  /** A pointer-down on a page's background, with the point in the page's top-left frame (points). */
  readonly onPagePointer?: (slot: PageSlot, point: { x: number; y: number }, e: ReactPointerEvent<HTMLElement>) => void;
  /** Pointer moves / up after a pointer-down on a page's background (the point is kept on the page). */
  readonly onPagePointerMove?: (slot: PageSlot, point: { x: number; y: number }, e: ReactPointerEvent<HTMLElement>) => void;
  readonly onPagePointerUp?: (slot: PageSlot, point: { x: number; y: number }, e: ReactPointerEvent<HTMLElement>) => void;
  /** P2-2 — the drag-a-box rectangle being drawn (top-left frame, points) and its page. */
  readonly marquee?: { readonly slotIndex: number; readonly rect: Box } | null;
  /** P2-3 — alignment guides on one page (top-left frame, points). */
  readonly guides?: { readonly docId: string; readonly page: number; readonly xs: readonly number[]; readonly ys: readonly number[] } | null;
  /** P2-3 — draw a grid of this step (points); null for none. */
  readonly grid?: number | null;
  readonly onFieldPointerDown?: (f: PlacedField, mode: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>, slot: PageSlot) => void;
  readonly onFieldPointerMove?: (e: ReactPointerEvent<HTMLElement>) => void;
  readonly onFieldPointerUp?: () => void;
  readonly onFieldFocus?: (f: PlacedField) => void;
  readonly onFieldKey?: (f: PlacedField, e: ReactKeyboardEvent<HTMLElement>) => void;
}

function PageCanvas({ render, docId, page, width }: { readonly render: PageRenderer; readonly docId: string; readonly page: number; readonly width: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) void render(docId, page, ref.current, width).catch(() => undefined);
  }, [render, docId, page, width]);
  return <canvas ref={ref} className="fpe-page__canvas" aria-hidden="true" />;
}

const pct = (v: number, of: number): string => `${(v / of) * 100}%`;

/** A pointer position in a page's top-left frame (points), kept on the page. */
function pagePoint(el: HTMLElement, e: { clientX: number; clientY: number }, size: PdfPageInfo): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const x = r.width > 0 ? ((e.clientX - r.left) / r.width) * size.width : 0;
  const y = r.height > 0 ? ((e.clientY - r.top) / r.height) * size.height : 0;
  return { x: Math.max(0, Math.min(size.width, x)), y: Math.max(0, Math.min(size.height, y)) };
}

export function PlacementPages({
  documents,
  renderPage,
  fields,
  faceOf,
  pageWidth,
  idPrefix: p,
  readOnly,
  selection = [],
  placing = false,
  onPagePointer,
  onPagePointerMove,
  onPagePointerUp,
  marquee = null,
  guides = null,
  grid = null,
  onFieldPointerDown,
  onFieldPointerMove,
  onFieldPointerUp,
  onFieldFocus,
  onFieldKey,
}: PlacementPagesProps) {
  const slots = pageSlotsOf(documents);
  const many = documents.length > 1;
  return (
    <div className="fpe-pages">
      {slots.map((slot) => {
        const { size } = slot;
        const name = many ? `${slot.title}, page ${slot.page + 1}` : `Page ${slot.page + 1}`;
        return (
          <div key={`${slot.docId}:${slot.page}`} className="fpe-pagewrap" style={{ width: pageWidth }}>
            <div className="fpe-pagewrap__lab" aria-hidden="true">
              <span className="fpe-ellipsis">{slot.title}</span>
              <span>Page {slot.page + 1}</span>
            </div>
            <section
              className={placing ? 'fpe-page fpe-page--placing' : 'fpe-page'}
              style={{ width: pageWidth, height: (pageWidth / size.width) * size.height }}
              aria-label={name}
              data-testid={`${p}-page-${slot.index}`}
              data-fpe-page={slot.index}
              id={`${p}-pg-${slot.docId}-${slot.page}`}
              onPointerDown={(e) => {
                if (onPagePointer === undefined) return;
                if (e.target !== e.currentTarget && !(e.target instanceof HTMLCanvasElement)) return;
                onPagePointer(slot, pagePoint(e.currentTarget, e, size), e);
              }}
              onPointerMove={onPagePointerMove === undefined ? undefined : (e) => onPagePointerMove(slot, pagePoint(e.currentTarget, e, size), e)}
              onPointerUp={onPagePointerUp === undefined ? undefined : (e) => onPagePointerUp(slot, pagePoint(e.currentTarget, e, size), e)}
            >
              <PageCanvas render={renderPage} docId={slot.docId} page={slot.page} width={pageWidth} />
              {grid !== null && grid > 0 ? (
                <div className="fpe-grid" aria-hidden="true" data-testid={`${p}-grid-${slot.index}`} style={{ backgroundSize: `${(grid / size.width) * pageWidth}px ${(grid / size.width) * pageWidth}px` }} />
              ) : null}
              {guides !== null && guides.docId === slot.docId && guides.page === slot.page ? (
                <>
                  {guides.xs.map((x) => (
                    <div key={`gx${x}`} className="fpe-guide fpe-guide--v" aria-hidden="true" data-testid={`${p}-guide-v`} style={{ left: pct(x, size.width) }} />
                  ))}
                  {guides.ys.map((y) => (
                    <div key={`gy${y}`} className="fpe-guide fpe-guide--h" aria-hidden="true" data-testid={`${p}-guide-h`} style={{ top: pct(y, size.height) }} />
                  ))}
                </>
              ) : null}
              {marquee !== null && marquee.slotIndex === slot.index ? (
                <div
                  className="fpe-marquee"
                  aria-hidden="true"
                  data-testid={`${p}-marquee`}
                  style={{ left: pct(marquee.rect.x, size.width), top: pct(marquee.rect.y, size.height), width: pct(marquee.rect.width, size.width), height: pct(marquee.rect.height, size.height) }}
                />
              ) : null}
              {fields
                .filter((f) => f.docId === slot.docId && f.page === slot.page && f.hidden !== true)
                .map((f) => {
                  const box = toTopLeft({ x: f.x, y: f.y, width: f.width, height: f.height }, size.height);
                  const face = faceOf(f);
                  const sel = selection.includes(f.id);
                  const interactive = !readOnly;
                  const cls = `fpe-field fpe-field--tone${face.color === undefined ? face.tone : 0}${sel ? ' is-selected' : ''}${interactive && f.locked !== true ? ' is-editable' : ''}${f.locked === true ? ' is-locked' : ''}`;
                  const colour = face.color === undefined ? {} : { borderColor: face.color, color: face.color, background: `${face.color}14` };
                  return (
                    <div
                      key={f.id}
                      className={cls}
                      style={{ left: pct(box.x, size.width), top: pct(box.y, size.height), width: pct(box.width, size.width), height: pct(box.height, size.height), ...colour }}
                      role={interactive ? 'button' : undefined}
                      tabIndex={interactive ? 0 : undefined}
                      aria-label={face.ariaLabel}
                      aria-pressed={interactive ? sel : undefined}
                      data-testid={`${p}-field-${f.id}`}
                      data-field-id={f.id}
                      onPointerDown={interactive ? (e) => onFieldPointerDown?.(f, 'move', e, slot) : undefined}
                      onPointerMove={interactive ? onFieldPointerMove : undefined}
                      onPointerUp={interactive ? onFieldPointerUp : undefined}
                      onPointerCancel={interactive ? onFieldPointerUp : undefined}
                      onFocus={interactive ? () => onFieldFocus?.(f) : undefined}
                      onKeyDown={interactive ? (e) => onFieldKey?.(f, e) : undefined}
                    >
                      {face.who !== null ? (
                        <span className="fpe-field__who" style={face.color === undefined ? undefined : { background: face.color }}>
                          {face.who}
                        </span>
                      ) : null}
                      <span className="fpe-field__label">{face.text}</span>
                      {interactive && sel && f.locked !== true ? (
                        <span
                          className="fpe-field__grip"
                          aria-hidden="true"
                          onPointerDown={(e) => onFieldPointerDown?.(f, 'resize', e, slot)}
                          onPointerMove={onFieldPointerMove}
                          onPointerUp={onFieldPointerUp}
                        />
                      ) : null}
                    </div>
                  );
                })}
            </section>
          </div>
        );
      })}
    </div>
  );
}

/** A neutral face for a read-only view: the type label and who fills it. */
export function defaultFace(
  f: PlacedField,
  opts: { readonly typeLabel: (type: string) => string; readonly assignees: readonly PlacementAssignee[]; readonly prefillLabel?: (key: string) => string; readonly unassigned: string },
): FieldFace {
  const page = f.page + 1;
  if (f.binding !== null) {
    const text = opts.prefillLabel?.(f.binding) ?? f.binding;
    return { text, who: null, ariaLabel: `${text}, page ${page}`, tone: 0 };
  }
  const i = opts.assignees.findIndex((a) => a.id === f.assignee);
  const a = i < 0 ? undefined : opts.assignees[i];
  const who = a?.label ?? opts.unassigned;
  const label = opts.typeLabel(f.type);
  return {
    text: f.type === 'CHECKBOX' ? '' : label,
    who,
    ariaLabel: `${label} field for ${who}, page ${page}`,
    tone: i < 0 ? 0 : (i % 5) + 1,
    ...(a?.color !== undefined ? { color: a.color } : {}),
  };
}
