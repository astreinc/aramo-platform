import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { withOptionalMark } from '@aramo/sign-client';

import { Btn, TextIn } from './controls.js';
import { fieldBox, type PageSize } from './field-geometry.js';
import { FIND_COPY, findMatches, findStatus, hasText, MIN_QUERY, stepMatch, type FindMatch, type TextLayer } from './find.js';
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
  locked,
  actionLabel,
  onField,
  onError,
  loadTextLayer,
}: {
  readonly base64: string;
  readonly fields: readonly SignField[];
  readonly display: (f: SignField) => FieldDisplay | null;
  readonly activeField: string | null;
  readonly label: (f: SignField) => string;
  /** FIELD-PARITY-1 P3 S-4 / S-5 — the sender's value: shown, not a target. */
  readonly locked?: (f: SignField) => boolean;
  readonly actionLabel: (f: SignField) => string;
  readonly onField: (f: SignField) => void;
  readonly onError: () => void;
  /**
   * UAT SIG-16 retest (web ≡ app) — this document's words with boxes for Find, from the
   * server's text layer for this signing session (the app's route). Absent: no Find.
   */
  readonly loadTextLayer?: () => Promise<TextLayer>;
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

  // UAT SIG-16 — Find in the document; retest (web ≡ app): the app's matching rules on the
  // server's word boxes (find.ts), Enter or › steps to the next match, and the bar stays in
  // view while the document scrolls (index.css).
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [layerState, setLayerState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [matches, setMatches] = useState<FindMatch[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const runFind = async () => {
    if (query.trim().length < MIN_QUERY || loadTextLayer === undefined) {
      setMatches([]);
      return;
    }
    // Enter again on the same results steps to the next match (as a browser's Find).
    if (matches !== null && matches.length > 0) {
      setHitIdx((i) => stepMatch(i, matches.length, 1));
      return;
    }
    let l = layer;
    if (l === null) {
      setLayerState('loading');
      try {
        l = await loadTextLayer();
        setLayer(l);
        setLayerState('ready');
      } catch {
        setLayerState('failed');
        return;
      }
    }
    setMatches(findMatches(l, query));
    setHitIdx(0);
  };
  const current = matches !== null && matches.length > 0 ? matches[Math.min(hitIdx, matches.length - 1)] : undefined;
  useEffect(() => {
    if (current === undefined) return;
    document.getElementById('sg-find-hit')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [current]);
  const status =
    layerState === 'loading'
      ? FIND_COPY.loading
      : layerState === 'failed'
        ? FIND_COPY.failed
        : matches === null
          ? null
          : findStatus({ query, matches, index: Math.min(hitIdx, Math.max(0, matches.length - 1)), searchable: layer === null || hasText(layer) });

  // Bring the active (next) field into view.
  useEffect(() => {
    if (activeField === null) return;
    const el = document.getElementById(`sg-f-${activeField}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, [activeField, pdf]);

  return (
    <div className="sg-pages" ref={wrap} data-testid="sg-pages">
      {pdf !== null && loadTextLayer !== undefined ? (
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
                  setMatches(null);
                  if (layerState === 'failed') setLayerState('idle');
                }}
                data-testid="sg-find-input"
              />
              <Btn type="submit" variant="secondary" disabled={layerState === 'loading' || query.trim() === ''} data-testid="sg-find-go">
                Find
              </Btn>
              {status !== null ? (
                <span className="sg-small sg-muted" role="status" data-testid="sg-find-count">
                  {status}
                </span>
              ) : null}
              {matches !== null && matches.length > 0 ? (
                <>
                  <Btn variant="quiet" disabled={matches.length < 2} aria-label="Previous match" onClick={() => setHitIdx((i) => stepMatch(i, matches.length, -1))} data-testid="sg-find-prev">
                    ‹
                  </Btn>
                  <Btn variant="quiet" disabled={matches.length < 2} aria-label="Next match" onClick={() => setHitIdx((i) => stepMatch(i, matches.length, 1))} data-testid="sg-find-next">
                    ›
                  </Btn>
                </>
              ) : null}
              <Btn
                variant="quiet"
                aria-label="Close find"
                onClick={() => {
                  setFindOpen(false);
                  setMatches(null);
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
            {matches !== null
              ? matches
                  .filter((m) => m.page === i)
                  .flatMap((m, n) =>
                    m.rects.map((r, k) => (
                      <span
                        key={`hit-${n}-${k}`}
                        id={m === current && k === 0 ? 'sg-find-hit' : undefined}
                        className={`sg-find__hit${m === current ? ' sg-find__hit--on' : ''}`}
                        style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                        aria-hidden="true"
                      />
                    )),
                  )
              : null}
            {fields
              .filter((f) => f.page_number === i)
              .map((f) => {
                const shown = display(f);
                const box = fieldBox(f, page);
                // UAT SIG-03 — a check box is drawn as the box itself: no "Check" badge, which
                // is wider than a small box and spilled over its caption and, on a phone, over
                // the neighbouring box (a tap meant for "Yes" toggled "No").
                // FIELD-PARITY-1 P3 T-5 — a radio option is drawn the same way, as a circle.
                const radio = f.field_type === 'RADIO';
                const box_ = f.field_type === 'CHECKBOX' || radio;
                const fixed = locked?.(f) === true;
                const cls = `sg-onpage${box_ ? ' sg-onpage--box' : ''}${radio ? ' sg-onpage--radio' : ''}${fixed ? ' sg-onpage--locked' : ''}${shown !== null ? ' sg-onpage--done' : ''}${shown !== null && f.field_type === 'SIGNATURE' ? ' sg-onpage--stamp' : ''}${f.required ? '' : ' sg-onpage--optional'}${activeField === f.field_id ? ' sg-onpage--active' : ''}`;
                return (
                  <div
                    key={f.field_id}
                    id={`sg-f-${f.field_id}`}
                    role={fixed ? 'note' : 'button'}
                    tabIndex={fixed ? undefined : 0}
                    className={cls}
                    style={box}
                    title={typeof f.tooltip === 'string' && f.tooltip.length > 0 ? f.tooltip : undefined}
                    aria-label={
                      fixed
                        ? `${label(f)}${shown?.kind === 'text' ? `: ${shown.value}` : ''}, filled in by the sender`
                        : shown !== null
                          ? `${label(f)}, filled. Select to change`
                          : `${actionLabel(f)}: ${label(f)}, page ${i + 1}${f.required ? ', required' : ''}`
                    }
                    onClick={() => {
                      if (!fixed) onField(f);
                    }}
                    onKeyDown={(e) => {
                      if (!fixed && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onField(f);
                      }
                    }}
                    data-testid="sg-onpage-field"
                  >
                    {shown === null ? (
                      // The one wording for a field the signer may skip (@aramo/sign-client), as in the app.
                      box_ || fixed ? null : <span className="sg-onpage__cta">{withOptionalMark(actionLabel(f), f.required)}</span>
                    ) : shown.kind === 'image' ? (
                      <img src={shown.value} alt="Your signature" className="sg-onpage__img" />
                    ) : (
                      <FitText className={f.field_type === 'SIGNATURE' || f.field_type === 'INITIALS' ? 'sg-onpage__sig' : 'sg-onpage__val'} text={shown.value} />
                    )}
                    {box_ && typeof f.label === 'string' && f.label.length > 0 ? (
                      // M-A6 §2.3 — the box's caption, beside the box. Like a form label, tapping
                      // it toggles this box (UAT SIG-03: a larger target that never overlaps
                      // the box above or below).
                      <span className="sg-onpage__caption" aria-hidden="true" data-testid="sg-onpage-caption">
                        {withOptionalMark(f.label, f.required)}
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
