import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { clampBox, loadPdf as defaultLoadPdf, toPdf, toTopLeft, type LoadedPdf, type PdfPageInfo } from '../pdf';

import { fixedFormFieldLabel, type FixedFormField, type FixedFormRole } from './fixed-form-model';
import './fixed-form.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.2 / §7.3 — the official PDF
// rendered page by page (the shared pdf.js helpers, loaded lazily) with the placed fields drawn
// over it. Editable in the Platform Studio's fixed-form mode (select, drag to move, drag the
// corner to resize — every box kept inside its page); read-only in the Org Home preview.
// Fields are stored PDF-native (bottom-left origin); the canvas works top-left (toTopLeft /
// toPdf, the same transform as the Sign prepare editor).

export interface FixedFormCanvasProps {
  readonly pdfBytes: ArrayBuffer | null;
  readonly fields: readonly FixedFormField[];
  readonly roles: readonly FixedFormRole[];
  readonly selected?: string | null;
  readonly editable?: boolean;
  readonly onSelect?: (field_key: string | null) => void;
  readonly onChange?: (fields: FixedFormField[]) => void;
  readonly onPage?: (page: number) => void;
  readonly variableLabel?: (key: string) => string;
  /** CSS width of a rendered page (px). */
  readonly pageWidth?: number;
  /** Injected in tests (pdf.js does not run under jsdom). */
  readonly loadPdfFn?: (bytes: ArrayBuffer) => Promise<LoadedPdf>;
}

type Drag = { key: string; mode: 'move' | 'resize'; startX: number; startY: number; box: { x: number; y: number; width: number; height: number }; page: number };

function roleTone(roles: readonly FixedFormRole[], role: string | null): number {
  const i = roles.findIndex((r) => r.role_key === role);
  return i < 0 ? 0 : (i % 5) + 1;
}

function PdfPage({ pdf, index, width }: { readonly pdf: LoadedPdf; readonly index: number; readonly width: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) void pdf.render(index, ref.current, width).catch(() => undefined);
  }, [pdf, index, width]);
  return <canvas ref={ref} className="ffs-page__canvas" aria-hidden="true" />;
}

export function FixedFormCanvas({
  pdfBytes,
  fields,
  roles,
  selected = null,
  editable = false,
  onSelect,
  onChange,
  onPage,
  variableLabel,
  pageWidth = 720,
  loadPdfFn = defaultLoadPdf,
}: FixedFormCanvasProps) {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    let live = true;
    let loaded: LoadedPdf | null = null;
    setPdf(null);
    setFailed(false);
    if (pdfBytes === null) return undefined;
    loadPdfFn(pdfBytes).then(
      (p) => {
        loaded = p;
        if (live) setPdf(p);
        else p.destroy();
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      loaded?.destroy();
    };
  }, [pdfBytes, loadPdfFn]);

  if (pdfBytes === null) return <div className="ffs-empty">No PDF yet. Upload the official form to place fields on it.</div>;
  if (failed) return <div className="ffs-empty" role="alert">The PDF could not be displayed.</div>;
  if (pdf === null) return <div className="ffs-empty">Loading the form…</div>;

  const scaleOf = (page: PdfPageInfo): number => pageWidth / page.width;

  function startDrag(e: ReactPointerEvent<HTMLElement>, f: FixedFormField, mode: Drag['mode']) {
    if (!editable || f.page_number === null || f.x === null || f.y === null || f.width === null || f.height === null) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect?.(f.field_key);
    const page = pdf!.pages[f.page_number];
    if (page === undefined) return;
    drag.current = {
      key: f.field_key,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box: toTopLeft({ x: f.x, y: f.y, width: f.width, height: f.height }, page.height),
      page: f.page_number,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (d === null || onChange === undefined) return;
    const page = pdf!.pages[d.page];
    if (page === undefined) return;
    const s = scaleOf(page);
    const dx = (e.clientX - d.startX) / s;
    const dy = (e.clientY - d.startY) / s;
    const next =
      d.mode === 'move'
        ? { ...d.box, x: d.box.x + dx, y: d.box.y + dy }
        : { ...d.box, width: d.box.width + dx, height: d.box.height + dy };
    const pdfBox = toPdf(clampBox(next, page), page.height);
    const round = (n: number): number => Math.round(n * 100) / 100;
    onChange(
      fields.map((f) =>
        f.field_key === d.key ? { ...f, x: round(pdfBox.x), y: round(pdfBox.y), width: round(pdfBox.width), height: round(pdfBox.height) } : f,
      ),
    );
  }

  function endDrag() {
    drag.current = null;
  }

  return (
    <div className="ffs-pages" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {pdf.pages.map((page, index) => {
        const s = scaleOf(page);
        return (
          <section
            key={index}
            className="ffs-page"
            style={{ width: pageWidth, height: page.height * s }}
            aria-label={`Page ${index + 1}`}
            data-testid={`ffs-page-${index}`}
            onPointerDown={() => {
              onPage?.(index);
              if (editable) onSelect?.(null);
            }}
          >
            <PdfPage pdf={pdf} index={index} width={pageWidth} />
            {fields
              .filter((f) => f.page_number === index && f.x !== null && f.y !== null && f.width !== null && f.height !== null)
              .map((f) => {
                const box = toTopLeft({ x: f.x!, y: f.y!, width: f.width!, height: f.height! }, page.height);
                const label =
                  f.binding_key !== null
                    ? (variableLabel?.(f.binding_key) ?? f.binding_key)
                    : `${fixedFormFieldLabel(f.field_type)} · ${roles.find((r) => r.role_key === f.signer_role)?.label ?? 'No role'}`;
                const isSel = selected === f.field_key;
                return (
                  <div
                    key={f.field_key}
                    className={`ffs-field ffs-field--tone${f.binding_key !== null ? 0 : roleTone(roles, f.signer_role)}${isSel ? ' is-selected' : ''}${editable ? ' is-editable' : ''}`}
                    style={{ left: box.x * s, top: box.y * s, width: box.width * s, height: box.height * s }}
                    role={editable ? 'button' : undefined}
                    tabIndex={editable ? 0 : undefined}
                    aria-label={label}
                    aria-pressed={editable ? isSel : undefined}
                    data-testid={`ffs-field-${f.field_key}`}
                    onPointerDown={(e) => startDrag(e, f, 'move')}
                    onKeyDown={(e) => {
                      if (editable && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onSelect?.(f.field_key);
                      }
                    }}
                  >
                    <span className="ffs-field__label">{label}</span>
                    {editable && isSel ? (
                      <span className="ffs-field__resize" aria-hidden="true" onPointerDown={(e) => startDrag(e, f, 'resize')} />
                    ) : null}
                  </div>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}
