import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { Btn, TextIn } from './controls.js';
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

// UAT SIG-16 — "Find" in the document (the app's More → Find, M-A12 W1-C.2), done in the
// browser from the PDF already loaded here: no extra request, no token use. A hit is one
// text run containing the query; its box is in page percentages (top-left origin).
export interface FindHit {
  readonly page: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type TextItemLike = { str?: string; transform?: number[]; width?: number; height?: number };
type ViewportLike = { width: number; height: number; convertToViewportRectangle: (r: number[]) => number[] };

/** The hits for `query` on one page (case-insensitive; whitespace-trimmed query). */
export function findOnPage(page: number, items: readonly TextItemLike[], vp: ViewportLike, query: string): FindHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: FindHit[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.toLowerCase().includes(q) || it.transform === undefined) continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const h = it.height && it.height > 0 ? it.height : Math.abs(it.transform[3] ?? 10);
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = vp.convertToViewportRectangle([x, y, x + (it.width ?? 0), y + h]);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    out.push({ page, left: (left / vp.width) * 100, top: (top / vp.height) * 100, width: (Math.abs(x2 - x1) / vp.width) * 100, height: (Math.abs(y2 - y1) / vp.height) * 100 });
  }
  return out;
}

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

  // UAT SIG-16 — Find in the document.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<FindHit[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const runFind = async () => {
    if (pdf === null || query.trim() === '') return;
    setSearching(true);
    const all: FindHit[] = [];
    try {
      for (let i = 0; i < pdf.pages.length; i += 1) {
        const page = await pdf.doc.getPage(i + 1);
        const tc = await page.getTextContent();
        all.push(...findOnPage(i, tc.items as TextItemLike[], page.getViewport({ scale: 1 }) as unknown as ViewportLike, query));
      }
    } catch {
      // A page without a text layer simply has no hits.
    }
    setHits(all);
    setHitIdx(0);
    setSearching(false);
  };
  const current = hits !== null && hits.length > 0 ? hits[Math.min(hitIdx, hits.length - 1)] : undefined;
  useEffect(() => {
    if (current === undefined) return;
    document.getElementById('sg-find-hit')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [current]);

  // Bring the active (next) field into view.
  useEffect(() => {
    if (activeField === null) return;
    const el = document.getElementById(`sg-f-${activeField}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, [activeField, pdf]);

  return (
    <div className="sg-pages" ref={wrap} data-testid="sg-pages">
      {pdf !== null ? (
        <div className="sg-find" data-testid="sg-find">
          {findOpen ? (
            <form
              className="sg-find__bar"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                void runFind();
              }}
            >
              <TextIn
                className="sg-input sg-find__input"
                aria-label="Find in document"
                placeholder="Find in document"
                value={query}
                autoFocus
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHits(null);
                }}
                data-testid="sg-find-input"
              />
              <Btn type="submit" variant="secondary" disabled={searching || query.trim() === ''} data-testid="sg-find-go">
                Find
              </Btn>
              {hits !== null ? (
                <>
                  <span className="sg-small sg-muted" role="status" data-testid="sg-find-count">
                    {hits.length === 0 ? 'No matches' : `${Math.min(hitIdx, hits.length - 1) + 1} of ${hits.length}`}
                  </span>
                  <Btn variant="quiet" disabled={hits.length < 2} aria-label="Previous match" onClick={() => setHitIdx((i) => (i - 1 + hits.length) % hits.length)}>
                    ‹
                  </Btn>
                  <Btn variant="quiet" disabled={hits.length < 2} aria-label="Next match" onClick={() => setHitIdx((i) => (i + 1) % hits.length)} data-testid="sg-find-next">
                    ›
                  </Btn>
                </>
              ) : null}
              <Btn
                variant="quiet"
                aria-label="Close find"
                onClick={() => {
                  setFindOpen(false);
                  setHits(null);
                }}
              >
                ✕
              </Btn>
            </form>
          ) : (
            <Btn variant="secondary" className="sg-find__open" onClick={() => setFindOpen(true)} data-testid="sg-find-open">
              Find
            </Btn>
          )}
        </div>
      ) : null}
      {pdf === null ? (
        <p className="sg-muted" role="status">
          Loading the document…
        </p>
      ) : (
        pdf.pages.map((page, i) => (
          <Page key={i} doc={pdf.doc} index={i} size={page} cssWidth={Math.max(280, width)}>
            {hits !== null
              ? hits
                  .filter((h) => h.page === i)
                  .map((h, n) => (
                    <span
                      key={`hit-${n}`}
                      id={h === current ? 'sg-find-hit' : undefined}
                      className={`sg-find__hit${h === current ? ' sg-find__hit--on' : ''}`}
                      style={{ left: `${h.left}%`, top: `${h.top}%`, width: `${h.width}%`, height: `${h.height}%` }}
                      aria-hidden="true"
                    />
                  ))
              : null}
            {fields
              .filter((f) => f.page_number === i)
              .map((f) => {
                const shown = display(f);
                const box = fieldBox(f, page);
                // UAT SIG-03 — a check box is drawn as the box itself: no "Check" badge, which
                // is wider than a small box and spilled over its caption and, on a phone, over
                // the neighbouring box (a tap meant for "Yes" toggled "No").
                const box_ = f.field_type === 'CHECKBOX';
                const cls = `sg-onpage${box_ ? ' sg-onpage--box' : ''}${shown !== null ? ' sg-onpage--done' : ''}${shown !== null && f.field_type === 'SIGNATURE' ? ' sg-onpage--stamp' : ''}${f.required ? '' : ' sg-onpage--optional'}${activeField === f.field_id ? ' sg-onpage--active' : ''}`;
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
                      box_ ? null : <span className="sg-onpage__cta">{actionLabel(f)}</span>
                    ) : shown.kind === 'image' ? (
                      <img src={shown.value} alt="Your signature" className="sg-onpage__img" />
                    ) : (
                      <FitText className={f.field_type === 'SIGNATURE' || f.field_type === 'INITIALS' ? 'sg-onpage__sig' : 'sg-onpage__val'} text={shown.value} />
                    )}
                    {f.field_type === 'CHECKBOX' && typeof f.label === 'string' && f.label.length > 0 ? (
                      // M-A6 §2.3 — the box's caption, beside the box. Like a form label, tapping
                      // it toggles this box (UAT SIG-03: a larger target that never overlaps
                      // the box above or below).
                      <span className="sg-onpage__caption" aria-hidden="true" data-testid="sg-onpage-caption">
                        {f.label}
                      </span>
                    ) : null}
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

// Shrinks text to fit its field box (like the PDF stamp, which fits the name to
// the field width): start from ~60% of the box height and step down until the
// text no longer overflows.
function FitText({ text, className }: { readonly text: string; readonly className: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      const box = el?.parentElement;
      if (!el || !box) return;
      let size = Math.max(8, box.clientHeight * 0.62);
      el.style.fontSize = `${size}px`;
      for (let i = 0; i < 60 && el.scrollWidth > box.clientWidth - 8 && size > 6; i += 1) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    // The handwriting web font loads asynchronously; measuring with the fallback
    // font under-sizes the box, so fit again once fonts are ready.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    let live = true;
    void fonts?.ready.then(() => {
      if (live) fit();
    });
    fonts?.addEventListener?.('loadingdone', fit);
    return () => {
      live = false;
      fonts?.removeEventListener?.('loadingdone', fit);
    };
  });
  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
