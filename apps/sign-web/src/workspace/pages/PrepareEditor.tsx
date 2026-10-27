import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorMessage, fetchSourcePdf, isCopyRecipient, senderApi, type EnvelopeDetail, type EnvelopeField, type FieldType } from '../api';
import { clampBox, toPdf, toTopLeft, type PdfPageInfo } from '../geometry';
import { loadPdf, type LoadedPdf } from '../pdf';
import { Bare, Btn, COLORS, Check, ErrorBox, Icon, Loading, Sel } from '../ui';

import { readinessOf } from './readiness';

// Step 3 · Prepare fields (prototype three-pane editor) over the REAL rendered
// PDF (PX-V1 §8). Left: recipient selector, field tools, pages. Centre: the
// page canvases with positioned fields. Right: the selected field's properties
// and send readiness.
//
// Mouse: pick a tool then click a page to place; drag to move; drag the corner to
// resize; click to select. Keyboard: Tab reaches each field (visible focus ring);
// arrows move 2pt (Shift: 10pt); Alt+arrows resize; Delete/Backspace removes;
// "Place on page 1 (keyboard)" adds the chosen field without a mouse. Undo (also
// Ctrl/Cmd+Z). Changes save automatically (fields are replaced as a whole).
//
// Editor frame: TOP-LEFT origin in PDF points, page index 0-based. Converted to
// the wire's bottom-left frame by toPdf on save.

export const TYPES: Record<FieldType, { label: string; glyph: string; w: number; h: number }> = {
  SIGNATURE: { label: 'Signature', glyph: '✍', w: 220, h: 48 },
  INITIALS: { label: 'Initials', glyph: 'AB', w: 60, h: 30 },
  SIGN_DATE: { label: 'Sign date', glyph: '📅', w: 150, h: 22 },
  SIGNER_NAME: { label: 'Signer name', glyph: 'Aa', w: 220, h: 22 },
  TEXT: { label: 'Text', glyph: 'T', w: 220, h: 22 },
  CHECKBOX: { label: 'Checkbox', glyph: '☑', w: 16, h: 16 },
  ACKNOWLEDGEMENT: { label: 'Acknowledgement', glyph: '✓', w: 400, h: 26 },
};
const TYPE_KEYS = Object.keys(TYPES) as FieldType[];
// PX-V1 §15 — V1 field types; the rest are shown but not placeable ("Not in V1").
export const V1_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT']);

interface EdField {
  key: string;
  docId: string;
  page: number; // 0-based
  signerId: string;
  type: FieldType;
  x: number; // top-left frame, points
  y: number;
  w: number;
  h: number;
  required: boolean;
}

interface DocPdf {
  docId: string;
  title: string;
  pdf: LoadedPdf;
}

let seq = 0;
const newKey = () => `f${Date.now().toString(36)}${(seq += 1)}`;

export function PrepareEditor({ env, onChange, back, next }: { env: EnvelopeDetail; onChange: (d: EnvelopeDetail) => void; back: string; next: string }) {
  const nav = useNavigate();
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1.5 — fields belong to signers only; a
  // recipient who receives a copy has none.
  const signers = env.recipients.filter((r) => !isCopyRecipient(r));
  const [docs, setDocs] = useState<DocPdf[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [fields, setFields] = useState<EdField[]>([]);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [rec, setRec] = useState<string | null>(signers[0]?.id ?? null);
  const [zoom, setZoom] = useState(1);
  const [undo, setUndo] = useState<EdField[][]>([]);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [colWidth, setColWidth] = useState(720);
  const colRef = useRef<HTMLDivElement>(null);

  const pageInfo = useCallback(
    (docId: string, page: number): PdfPageInfo | undefined => docs?.find((d) => d.docId === docId)?.pdf.pages[page],
    [docs],
  );

  // Load + measure each source PDF, then project stored fields into the editor frame.
  useEffect(() => {
    let live = true;
    const loaded: DocPdf[] = [];
    (async () => {
      for (const d of env.documents) {
        const bytes = await fetchSourcePdf(env.id, d.id);
        const pdf = await loadPdf(bytes);
        loaded.push({ docId: d.id, title: d.title, pdf });
      }
      if (!live) return;
      setDocs(loaded);
      const byDoc = new Map(loaded.map((d) => [d.docId, d.pdf.pages]));
      setFields(
        env.fields.flatMap((f) => {
          const page = byDoc.get(f.envelope_document_id)?.[f.page_number];
          if (page === undefined) return [];
          const tl = toTopLeft({ x: f.x, y: f.y, width: f.width, height: f.height }, page.height);
          return [{ key: f.id ?? newKey(), docId: f.envelope_document_id, page: f.page_number, signerId: f.signer_id, type: f.field_type, x: tl.x, y: tl.y, w: tl.width, h: tl.height, required: f.required }];
        }),
      );
      setReady(true);
    })().catch((e: unknown) => {
      if (live) setLoadError(errorMessage(e, 'The document could not be loaded.'));
    });
    return () => {
      live = false;
      for (const d of loaded) d.pdf.destroy();
    };
    // Load once per envelope + document set.
  }, [env.id, env.documents.map((d) => d.id).join(',')]);

  // Column width → page CSS width.
  useEffect(() => {
    const el = colRef.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => setColWidth(el.clientWidth));
    ro.observe(el);
    setColWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ready]);

  // Autosave (debounced) after any change once loaded.
  const firstSave = useRef(true);
  useEffect(() => {
    if (!ready) return undefined;
    if (firstSave.current) {
      firstSave.current = false;
      return undefined;
    }
    setSave('saving');
    const t = setTimeout(() => {
      const wire: EnvelopeField[] = fields.flatMap((f) => {
        const page = pageInfo(f.docId, f.page);
        if (page === undefined) return [];
        const b = toPdf({ x: f.x, y: f.y, width: f.w, height: f.h }, page.height);
        return [{ envelope_document_id: f.docId, signer_id: f.signerId, field_type: f.type, page_number: f.page, x: b.x, y: b.y, width: b.width, height: b.height, required: f.required }];
      });
      senderApi
        .fields(env.id, wire)
        .then((d) => {
          onChange(d);
          setSave('saved');
          setSaveError('');
        })
        .catch((e: unknown) => {
          setSave('error');
          setSaveError(errorMessage(e));
        });
    }, 600);
    return () => clearTimeout(t);
    // onChange is stable enough (setState); fields drive the save.
  }, [fields, ready]);

  const colorOf = useCallback((signerId: string) => {
    const i = env.recipients.findIndex((r) => r.id === signerId);
    return i < 0 ? '#8B94A3' : (COLORS[i % COLORS.length] ?? '#2447D8');
  }, [env.recipients]);
  const nameOf = (signerId: string) => env.recipients.find((r) => r.id === signerId)?.name ?? 'Unassigned';

  const commit = (next: EdField[]) => {
    setUndo((u) => [...u.slice(-19), fields]);
    setFields(next);
  };
  const doUndo = () => {
    setUndo((u) => {
      const prev = u[u.length - 1];
      if (prev !== undefined) setFields(prev);
      return u.slice(0, -1);
    });
  };

  const place = (docId: string, page: number, cx: number, cy: number) => {
    if (tool === null) return;
    const info = pageInfo(docId, page);
    const signer = rec ?? signers[0]?.id;
    if (info === undefined || signer === undefined) return;
    const t = TYPES[tool];
    const box = clampBox({ x: cx - t.w / 2, y: cy - t.h / 2, width: t.w, height: t.h }, info);
    const f: EdField = { key: newKey(), docId, page, signerId: signer, type: tool, x: box.x, y: box.y, w: box.width, h: box.height, required: true };
    commit([...fields, f]);
    setSel(f.key);
    setTool(null);
  };

  const placeKeyboard = () => {
    const d = docs?.[0];
    const info = d?.pdf.pages[0];
    if (d === undefined || info === undefined) return;
    place(d.docId, 0, info.width / 2, info.height / 2);
  };

  const update = (key: string, fn: (f: EdField) => EdField, record = true) => {
    const next = fields.map((f) => (f.key === key ? fn(f) : f));
    if (record) commit(next);
    else setFields(next);
  };
  const remove = (key: string) => {
    commit(fields.filter((f) => f.key !== key));
    setSel(null);
  };

  const selected = fields.find((f) => f.key === sel) ?? null;
  const pageW = Math.max(280, Math.min(colWidth, 760) * zoom);
  const readiness = useMemo(() => readinessOf(env), [env]);

  // Global undo shortcut.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        doUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (env.documents.length === 0 || signers.length === 0) {
    return (
      <>
        <div className="sg-card sg-empty" data-testid="prepare-missing">
          <div className="sg-empty__t">{env.documents.length === 0 ? 'Add a document first' : 'Add a signer first'}</div>
          {env.documents.length === 0 ? 'Fields are placed on the envelope’s documents (step 1).' : 'Each field belongs to a signer you add in step 2.'}
        </div>
        <div className="sg-wizfoot">
          <Btn onClick={() => nav(back)}>
            <Icon name="back" size={14} /> Back
          </Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sg-editor">
        {/* Left — recipients, tools, pages */}
        <div className="sg-editor__side">
          <div className="sg-panel">
            <div className="sg-panel__t">Placing for</div>
            {signers.map((r) => {
              const n = fields.filter((f) => f.signerId === r.id).length;
              return (
                <Bare key={r.id} className={r.id === rec ? 'sg-recsel sg-recsel--on' : 'sg-recsel'} aria-pressed={r.id === rec} onClick={() => setRec(r.id)}>
                  <span className="sg-swatch" style={{ background: colorOf(r.id) }} />
                  <span className="sg-ellipsis" style={{ flex: 1, fontWeight: 600 }}>
                    {r.name}
                  </span>
                  <span className="sg-faint" style={{ fontSize: 11.5 }}>
                    {n} field{n === 1 ? '' : 's'}
                  </span>
                </Bare>
              );
            })}
          </div>
          <div className="sg-panel">
            <div className="sg-panel__t">Fields · click a type, then the page</div>
            {TYPE_KEYS.map((t) => {
              const v1 = V1_TYPES.has(t);
              return (
                <Bare
                  key={t}
                  className={tool === t ? 'sg-tool sg-tool--on' : 'sg-tool'}
                  aria-pressed={tool === t}
                  disabled={!v1}
                  title={v1 ? undefined : 'Not available in this version of Aramo Sign'}
                  onClick={() => setTool(tool === t ? null : t)}
                  data-testid={`tool-${t}`}
                >
                  <span className="sg-tool__g" aria-hidden="true">
                    {TYPES[t].glyph}
                  </span>
                  {TYPES[t].label}
                  {v1 ? null : (
                    <span className="sg-tag sg-tag--grey" style={{ marginLeft: 'auto' }}>
                      Not in V1
                    </span>
                  )}
                </Bare>
              );
            })}
            {tool !== null ? (
              <Btn size="sm" block onClick={placeKeyboard} data-testid="place-keyboard">
                Place on page 1 (keyboard)
              </Btn>
            ) : null}
          </div>
          <div className="sg-panel">
            <div className="sg-panel__t">Pages</div>
            {(docs ?? []).flatMap((d) =>
              d.pdf.pages.map((_, i) => (
                <Bare
                  key={`${d.docId}:${i}`}
                  className="sg-thumb"
                  onClick={() => document.getElementById(`pg-${d.docId}-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <span className="sg-thumb__box" aria-hidden="true" />
                  <span className="sg-ellipsis" style={{ flex: 1 }}>
                    {d.title}
                  </span>
                  <span className="sg-faint">{i + 1}</span>
                </Bare>
              )),
            )}
          </div>
        </div>

        {/* Centre — pages */}
        <div ref={colRef} style={{ minWidth: 0 }}>
          <div className="sg-canvas__bar">
            <span style={{ flex: 1 }}>
              {tool !== null ? `Click the page to place a ${TYPES[tool].label.toLowerCase()} field for ${nameOf(rec ?? '')}.` : 'Pick a field type on the left, then click the page. Click a field to edit; drag to move.'}
            </span>
            <Btn size="sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.1) * 10) / 10))}>
              −
            </Btn>
            <span className="sg-mono" style={{ width: 44, textAlign: 'center' }}>
              {Math.round(zoom * 100)}%
            </span>
            <Btn size="sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}>
              +
            </Btn>
            <Btn size="sm" onClick={doUndo} disabled={undo.length === 0}>
              Undo
            </Btn>
            <span className="sg-faint" style={{ fontSize: 12, minWidth: 60 }} role="status" data-testid="save-state">
              {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved' : ''}
            </span>
          </div>
          {loadError !== '' ? <ErrorBox>{loadError}</ErrorBox> : null}
          {saveError !== '' ? <ErrorBox>{saveError}</ErrorBox> : null}
          {!ready && loadError === '' ? <Loading label="Rendering pages…" /> : null}
          {(docs ?? []).flatMap((d) =>
            d.pdf.pages.map((info, i) => (
              <PageView
                key={`${d.docId}:${i}`}
                id={`pg-${d.docId}-${i}`}
                pdf={d.pdf}
                pageIndex={i}
                info={info}
                cssWidth={pageW}
                label={d.title}
                placing={tool !== null}
                onPlace={(x, y) => place(d.docId, i, x, y)}
                onBackground={() => setSel(null)}
              >
                {fields
                  .filter((f) => f.docId === d.docId && f.page === i)
                  .map((f) => (
                    <FieldBox
                      key={f.key}
                      f={f}
                      info={info}
                      color={colorOf(f.signerId)}
                      who={nameOf(f.signerId).split(' ')[0] ?? ''}
                      selected={f.key === sel}
                      onSelect={() => setSel(f.key)}
                      onStart={() => setUndo((u) => [...u.slice(-19), fields])}
                      onLive={(fn) => update(f.key, fn, false)}
                      onKey={(e) => {
                        const step = e.shiftKey ? 10 : 2;
                        const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                        const a = arrows[e.key];
                        if (a !== undefined) {
                          e.preventDefault();
                          update(f.key, (x) => {
                            const b = e.altKey
                              ? clampBox({ x: x.x, y: x.y, width: x.w + a[0], height: x.h + a[1] }, info)
                              : clampBox({ x: x.x + a[0], y: x.y + a[1], width: x.w, height: x.h }, info);
                            return { ...x, x: b.x, y: b.y, w: b.width, h: b.height };
                          });
                        } else if (e.key === 'Delete' || e.key === 'Backspace') {
                          e.preventDefault();
                          remove(f.key);
                        } else if (e.key === 'Escape') {
                          setSel(null);
                        }
                      }}
                    />
                  ))}
              </PageView>
            )),
          )}
        </div>

        {/* Right — properties + readiness */}
        <div className="sg-editor__side sg-editor__props">
          <div className="sg-panel" data-testid="field-properties">
            <div className="sg-panel__t">Field properties</div>
            {selected === null ? (
              <div className="sg-muted" style={{ fontSize: 13 }}>
                Select a field on the page to edit it. Drag to move; drag the corner handle to resize.
              </div>
            ) : (
              <div className="sg-grid" style={{ gap: 10 }}>
                <div>
                  <strong>{TYPES[selected.type].label}</strong>
                  <div className="sg-faint" style={{ fontSize: 12 }}>
                    Page {selected.page + 1} · {Math.round(selected.w)} × {Math.round(selected.h)} pt
                  </div>
                </div>
                <label className="sg-field">
                  <span className="sg-label">Recipient</span>
                  <Sel value={selected.signerId} onChange={(e) => update(selected.key, (x) => ({ ...x, signerId: e.target.value }))}>
                    {signers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Sel>
                </label>
                <label className="sg-check">
                  <Check checked={selected.required} onChange={(e) => update(selected.key, (x) => ({ ...x, required: e.target.checked }))} />
                  Required
                </label>
                <Btn variant="danger" size="sm" onClick={() => remove(selected.key)}>
                  Delete field
                </Btn>
              </div>
            )}
          </div>
          <div className="sg-panel">
            <div className="sg-panel__t">Readiness</div>
            {readiness.items.map((it) => (
              <div key={it.t} className="sg-check" style={{ fontSize: 13 }}>
                <span className={it.ok ? 'sg-check__ok' : 'sg-check__no'} aria-hidden="true">
                  {it.ok ? '✓' : '!'}
                </span>
                {it.t}
              </div>
            ))}
          </div>
          <Btn block disabled title="Previewing as a recipient needs a sender-scoped preview session (proposed)">
            Preview as recipient · Proposed
          </Btn>
        </div>
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(back)}>
          <Icon name="back" size={14} /> Back
        </Btn>
        <Btn variant="primary" onClick={() => nav(next)} disabled={save === 'saving'} data-testid="prepare-review">
          Review <Icon name="next" size={14} />
        </Btn>
      </div>
    </>
  );
}

function PageView({
  id,
  pdf,
  pageIndex,
  info,
  cssWidth,
  label,
  placing,
  onPlace,
  onBackground,
  children,
}: {
  id: string;
  pdf: LoadedPdf;
  pageIndex: number;
  info: PdfPageInfo;
  cssWidth: number;
  label: string;
  placing: boolean;
  onPlace: (x: number, y: number) => void;
  onBackground: () => void;
  children: React.ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current !== null) void pdf.render(pageIndex, canvas.current, cssWidth).catch(() => undefined);
  }, [pdf, pageIndex, cssWidth]);
  const cssHeight = (cssWidth / info.width) * info.height;
  return (
    <div className="sg-pagewrap" style={{ width: cssWidth }} id={id}>
      <div className="sg-pagewrap__lab">
        <span className="sg-ellipsis">{label}</span>
        <span>Page {pageIndex + 1}</span>
      </div>
      <div
        className={placing ? 'sg-pageview sg-pageview--placing' : 'sg-pageview'}
        style={{ width: cssWidth, height: cssHeight }}
        data-testid={`page-${pageIndex}`}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget && !(e.target instanceof HTMLCanvasElement)) return;
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * info.width;
          const y = ((e.clientY - r.top) / r.height) * info.height;
          if (placing) onPlace(x, y);
          else onBackground();
        }}
      >
        <canvas ref={canvas} aria-label={`${label}, page ${pageIndex + 1}`} />
        {children}
      </div>
    </div>
  );
}

function FieldBox({
  f,
  info,
  color,
  who,
  selected,
  onSelect,
  onStart,
  onLive,
  onKey,
}: {
  f: EdField;
  info: PdfPageInfo;
  color: string;
  who: string;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onLive: (fn: (f: EdField) => EdField) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const drag = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; scale: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const start = (e: PointerEvent<HTMLElement>, mode: 'move' | 'size') => {
    e.stopPropagation();
    e.preventDefault();
    const page = (e.currentTarget as HTMLElement).closest('.sg-pageview');
    if (page === null) return;
    const r = page.getBoundingClientRect();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, scale: info.width / r.width, ox: f.x, oy: f.y, ow: f.w, oh: f.h };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onStart();
    onSelect();
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    const dx = (e.clientX - d.sx) * d.scale;
    const dy = (e.clientY - d.sy) * d.scale;
    onLive((x) => {
      const b =
        d.mode === 'move'
          ? clampBox({ x: d.ox + dx, y: d.oy + dy, width: x.w, height: x.h }, info)
          : clampBox({ x: x.x, y: x.y, width: d.ow + dx, height: d.oh + dy }, info);
      return { ...x, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    });
  };
  const end = () => {
    drag.current = null;
  };
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${TYPES[f.type].label} field for ${who}, page ${f.page + 1}`}
      aria-pressed={selected}
      className={selected ? 'sg-fieldbox sg-fieldbox--sel' : 'sg-fieldbox'}
      style={{ left: pct(f.x, info.width), top: pct(f.y, info.height), width: pct(f.w, info.width), height: pct(f.h, info.height), borderColor: color, color, background: `${color}14` }}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onFocus={onSelect}
      onKeyDown={onKey}
      data-testid="field-box"
    >
      <span className="sg-fieldbox__who" style={{ background: color }}>
        {who}
      </span>
      {f.type === 'CHECKBOX' ? '' : TYPES[f.type].label}
      {selected ? <span className="sg-fieldbox__grip" style={{ borderColor: color }} onPointerDown={(e) => start(e, 'size')} onPointerMove={move} onPointerUp={end} aria-hidden="true" /> : null}
    </div>
  );
}
