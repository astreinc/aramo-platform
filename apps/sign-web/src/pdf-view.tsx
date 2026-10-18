import { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { fieldBox, type PageSize } from './field-geometry.js';
import type { SignField } from './sign-api';

// PX-V1 §9 (PX-2) — the signer reviews the ACTUAL PDF with their fields in their
// true positions and signs by clicking a field on the page. Pages are rendered
// with pdfjs-dist; each field is an absolutely-positioned box over its page.
//
// Geometry: fields arrive PDF-native — page_number 0-based, points, origin at the
// page's BOTTOM-LEFT, (x, y) the box's lower-left corner (the frame the execution
// stamper draws in). The overlay converts to CSS top-left percentages.

type Pdf = Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>;

export interface FieldDisplay {
  // What the box shows once filled: typed text, a drawn-image data URL, or a mark.
  readonly kind: 'text' | 'image' | 'mark';
  readonly value: string;
}

export function PdfDocument({
  base64,
  fields,
  display,
  activeField,
  label,
  actionLabel,
  onField,
  onError,
}: {
  readonly base64: string;
  readonly fields: readonly SignField[];
  readonly display: (f: SignField) => FieldDisplay | null;
  readonly activeField: string | null;
  readonly label: (f: SignField) => string;
  readonly actionLabel: (f: SignField) => string;
  readonly onField: (f: SignField) => void;
  readonly onError: () => void;
}): JSX.Element {
  const [pdf, setPdf] = useState<{ doc: Pdf; pages: PageSize[] } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);

  useEffect(() => {
    let live = true;
    let loaded: Pdf | null = null;
    (async () => {
      const lib = await import('pdfjs-dist');
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      loaded = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      const pages: PageSize[] = [];
      for (let i = 1; i <= loaded.numPages; i += 1) {
        const vp = (await loaded.getPage(i)).getViewport({ scale: 1 });
        pages.push({ width: vp.width, height: vp.height });
      }
      if (live) setPdf({ doc: loaded, pages });
    })().catch(() => {
      if (live) onError();
    });
    return () => {
      live = false;
      if (loaded !== null) void loaded.destroy();
    };
  }, [base64, onError]);

  useEffect(() => {
    const el = wrap.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth - 32, 900)));
    ro.observe(el);
    setWidth(Math.min(el.clientWidth - 32, 900));
    return () => ro.disconnect();
  }, []);

  // Bring the active (next) field into view.
  useEffect(() => {
    if (activeField === null) return;
    const el = document.getElementById(`sg-f-${activeField}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, [activeField, pdf]);

  return (
    <div className="sg-pages" ref={wrap} data-testid="sg-pages">
      {pdf === null ? (
        <p className="sg-muted" role="status">
          Loading the document…
        </p>
      ) : (
        pdf.pages.map((page, i) => (
          <Page key={i} doc={pdf.doc} index={i} size={page} cssWidth={Math.max(280, width)}>
            {fields
              .filter((f) => f.page_number === i)
              .map((f) => {
                const shown = display(f);
                const box = fieldBox(f, page);
                const cls = `sg-onpage${shown !== null ? ' sg-onpage--done' : ''}${f.required ? '' : ' sg-onpage--optional'}${activeField === f.field_id ? ' sg-onpage--active' : ''}`;
                return (
                  <div
                    key={f.field_id}
                    id={`sg-f-${f.field_id}`}
                    role="button"
                    tabIndex={0}
                    className={cls}
                    style={box}
                    aria-label={shown !== null ? `${label(f)}, filled. Select to change` : `${actionLabel(f)}: ${label(f)}, page ${i + 1}${f.required ? ', required' : ''}`}
                    onClick={() => onField(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onField(f);
                      }
                    }}
                    data-testid="sg-onpage-field"
                  >
                    {shown === null ? (
                      <span className="sg-onpage__cta">{actionLabel(f)}</span>
                    ) : shown.kind === 'image' ? (
                      <img src={shown.value} alt="Your signature" className="sg-onpage__img" />
                    ) : (
                      <span className={f.field_type === 'SIGNATURE' || f.field_type === 'INITIALS' ? 'sg-onpage__sig' : 'sg-onpage__val'}>{shown.value}</span>
                    )}
                  </div>
                );
              })}
          </Page>
        ))
      )}
    </div>
  );
}

function Page({ doc, index, size, cssWidth, children }: { doc: Pdf; index: number; size: PageSize; cssWidth: number; children: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel: () => void } | null = null;
    (async () => {
      const page = await doc.getPage(index + 1);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: (cssWidth / size.width) * ratio });
      const c = canvas.current;
      if (c === null) return;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      if (ctx === null) return;
      const t = page.render({ canvasContext: ctx, viewport: vp });
      task = t;
      await t.promise;
    })().catch(() => undefined);
    return () => task?.cancel();
  }, [doc, index, size.width, cssWidth]);
  return (
    <div className="sg-page" style={{ width: cssWidth, height: (cssWidth / size.width) * size.height }} aria-label={`Page ${index + 1}`}>
      <canvas ref={canvas} aria-hidden="true" />
      {children}
    </div>
  );
}
