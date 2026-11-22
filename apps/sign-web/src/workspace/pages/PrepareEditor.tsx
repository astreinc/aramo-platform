import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadPdf, type LoadedPdf } from '@aramo/document-templates-web/pdf';
import { PlacementEditor, suggestionsFromWire, useAutosave, type PlacedField, type PlacementCapabilities, type PlacementDocument, type PlacementSuggestion } from '@aramo/field-placement-web';
import { CHECKBOX_GROUP_KEY_MAX, CHECKBOX_LABEL_MAX, FIELD_CATALOG, FIELD_DEFAULTS, fieldTypesFor, placeableFieldTypes } from '@aramo/sign-client';

import { errorMessage, fetchSourcePdf, isCopyRecipient, senderApi, type EnvelopeDetail, type EnvelopeField, type FieldType } from '../api';
import { Btn, COLORS, ErrorBox, Icon, Loading } from '../ui';

import { configFromWire, configToWire } from './field-config';
import { readinessOf } from './readiness';

// Step 3 · Prepare fields over the REAL rendered PDF (PX-V1 §8).
//
// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-5,
// ruling R-8 — the palette, page column, field properties, keyboard map, undo and the viewport
// behaviour are the ONE shared placement editor (@aramo/field-placement-web), the same one the
// console's form Studio uses. This screen supplies its data (the envelope's documents, its
// signers, its stored fields) and keeps its own chrome (readiness, the wizard footer) and its
// API call: changes save automatically, 600ms after the last edit, as one PUT of the whole
// field set (senderApi.fields), exactly as before.
//
// Fields stay PDF-native (bottom-left origin, points, page 0-based) end to end; the editor
// converts to its top-left frame only inside a gesture.

// The display entry of every Sign type (label / glyph from the catalog; P1-0: the default size
// and whether a new field starts required from the ONE table).
export const TYPES: Record<FieldType, { label: string; glyph: string; w: number; h: number; required: boolean }> = Object.fromEntries(
  (fieldTypesFor('sign_store') as FieldType[]).map((t) => [t, { label: FIELD_CATALOG[t].label, glyph: FIELD_CATALOG[t].glyph, w: FIELD_DEFAULTS[t].width, h: FIELD_DEFAULTS[t].height, required: FIELD_DEFAULTS[t].required }]),
) as Record<FieldType, { label: string; glyph: string; w: number; h: number; required: boolean }>;
// Row 35 — the placeable types (the server's authoring list). PAYMENT is offered only when the
// server reports payments available AND the editor can author a payment's amount; this editor
// cannot yet, so a PAYMENT (placed through the API) stays shown but locked here.
// FIELD-PARITY-1 P3 — ACKNOWLEDGEMENT (ruling R-2) and the new types (DATE, DROPDOWN, RADIO,
// NUMBER, MULTILINE_TEXT) are authored here now, with every setting: nothing is pending.
export const P3_PENDING_WEB_TYPES: ReadonlySet<string> = new Set<string>();
export const V1_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(placeableFieldTypes({ payments_available: false }).filter((t) => !P3_PENDING_WEB_TYPES.has(t)));

// The Prepare palette order (unchanged from before P1-5), then ACKNOWLEDGEMENT and the Phase 3 types.
const ORDER: readonly FieldType[] = [
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'SIGNER_NAME',
  'TEXT',
  'CHECKBOX',
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL',
  'COMPANY',
  'TITLE',
  'DATE',
  'DROPDOWN',
  'RADIO',
  'NUMBER',
  'MULTILINE_TEXT',
  'ACKNOWLEDGEMENT',
];

/** FIELD-PARITY-1 P3 §6.2 — the settings Prepare edits (the Sign sender API stores every one). */
export const PREPARE_SETTINGS = ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode', 'tooltip', 'placeholder', 'validation', 'font_size', 'data_name', 'options'] as const;

/** The editor capabilities: sender-filled (and read-only) only while the server says they are on (S-5, dark). */
export function prepareCapabilities(env: Pick<EnvelopeDetail, 'sender_filled_fields_enabled'>): PlacementCapabilities {
  const senderFilled = env.sender_filled_fields_enabled === true;
  return {
    settings: senderFilled ? [...PREPARE_SETTINGS, 'read_only', 'sender_filled'] : PREPARE_SETTINGS,
    limits: { labelMax: CHECKBOX_LABEL_MAX, groupKeyMax: CHECKBOX_GROUP_KEY_MAX },
    senderValues: senderFilled,
  };
}

interface DocPdf {
  docId: string;
  title: string;
  pdf: LoadedPdf;
}

let seq = 0;
const newKey = () => `f${Date.now().toString(36)}${(seq += 1)}`;

/**
 * Stored field → editor. A type the sender cannot author (M-A6 §2) is kept locked with the stored
 * field; so is an engine row with no recipient or size (an S2S / Sign API ACKNOWLEDGEMENT), which
 * the server passes through only unchanged, with its id.
 */
export function toPlaced(f: EnvelopeField): PlacedField {
  return {
    id: f.id ?? newKey(),
    type: f.field_type,
    docId: f.envelope_document_id,
    page: f.page_number,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    assignee: f.signer_id,
    binding: null,
    settings: configFromWire(f),
    ...(V1_TYPES.has(f.field_type) && f.signer_id && f.width != null && f.height != null ? {} : { locked: true }),
  };
}

/**
 * Editor → the PUT payload, the same shape as before P1-5: a locked field goes back exactly as
 * stored (with its id, so the server keeps it); every other field without an id, with the
 * configuration its type takes.
 */
export function toWire(placed: readonly PlacedField[], stored: ReadonlyMap<string, EnvelopeField>): EnvelopeField[] {
  return placed.flatMap((f) => {
    const orig = stored.get(f.id);
    if (f.locked === true && orig !== undefined) return [orig];
    const type = f.type as FieldType;
    return [{ envelope_document_id: f.docId, signer_id: f.assignee ?? '', field_type: type, page_number: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, ...configToWire(type, f.settings) }];
  });
}

export function PrepareEditor({ env, onChange, back, next }: { env: EnvelopeDetail; onChange: (d: EnvelopeDetail) => void; back: string; next: string }) {
  const nav = useNavigate();
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1.5 — fields belong to signers only; a
  // recipient who receives a copy has none.
  const signers = env.recipients.filter((r) => !isCopyRecipient(r));
  const [docs, setDocs] = useState<DocPdf[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [initial, setInitial] = useState<PlacedField[]>([]);
  const [stored, setStored] = useState<ReadonlyMap<string, EnvelopeField>>(new Map());
  const [loadKey, setLoadKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef<readonly PlacedField[]>([]);

  // Load + measure each source PDF; keep the stored fields whose page exists.
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
      const kept = env.fields.filter((f) => byDoc.get(f.envelope_document_id)?.[f.page_number] !== undefined);
      const placed = kept.map(toPlaced);
      setStored(new Map(kept.map((f, i) => [placed[i]!.id, f] as const)));
      setInitial(placed);
      latest.current = placed;
      setLoadKey((k) => k + 1);
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

  const documents = useMemo<PlacementDocument[]>(() => (docs ?? []).map((d) => ({ id: d.docId, title: d.title, pages: d.pdf.pages })), [docs]);
  const renderPage = useCallback(
    (docId: string, page: number, canvas: HTMLCanvasElement, width: number) => docs?.find((d) => d.docId === docId)?.pdf.render(page, canvas, width) ?? Promise.resolve(),
    [docs],
  );
  const assignees = useMemo(
    () =>
      signers.map((r) => {
        const i = env.recipients.findIndex((x) => x.id === r.id);
        return { id: r.id, label: r.name, color: COLORS[i % COLORS.length] ?? '#2447D8' };
      }),
    [env.recipients],
  );

  const autosave = useAutosave({
    revision,
    enabled: ready,
    save: async () => {
      const d = await senderApi.fields(env.id, toWire(latest.current, stored));
      onChange(d);
    },
    formatError: (e) => errorMessage(e),
  });
  const readiness = useMemo(() => readinessOf(env), [env]);
  const capabilities = useMemo(() => prepareCapabilities(env), [env.sender_filled_fields_enabled]);
  // FIELD-PARITY-1 P2-4 — "Find fields": the Sign route's full detector (detect=all) for every
  // document, as ghosts in the editor. A document whose suggestions fail adds none.
  const docIds = env.documents.map((d) => d.id).join(',');
  const loadSuggestions = useCallback(async (): Promise<PlacementSuggestion[]> => {
    const lists = await Promise.all(
      env.documents.map(async (d) => {
        try {
          return suggestionsFromWire(d.id, (await senderApi.fieldSuggestions(env.id, d.id)).suggestions);
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
    // One loader per envelope + document set.
  }, [env.id, docIds]);

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
      <div className="sg-prepare">
        <PlacementEditor
          documents={documents}
          renderPage={renderPage}
          surface="send_web"
          // Sign 1.14 / P1-6 — Prepare cannot author a payment's amount yet: PAYMENT stays off the
          // palette (an API-placed one is shown locked).
          paymentsAvailable={false}
          palette={{ order: ORDER }}
          fields={initial}
          resetKey={loadKey}
          onChange={(f) => {
            latest.current = f;
            setRevision((r) => r + 1);
          }}
          assignees={assignees}
          capabilities={capabilities}
          newFieldId={() => newKey()}
          paletteMode="arm"
          precision="integer"
          pageWidth="fit"
          idPrefix="prep"
          copy={{ paletteTitle: 'Fields · click a type, then the page', leftLabel: 'Recipients and fields', rightLabel: 'Field properties and readiness' }}
          whoOf={(a) => a.label.split(' ')[0] ?? a.label}
          loadSuggestions={loadSuggestions}
          fitHeight={{ bottomReserve: 120 }}
          toolbarEnd={
            <span className="sg-faint" style={{ fontSize: 12, minWidth: 60 }} role="status" data-testid="save-state">
              {autosave.state === 'saving' ? 'Saving…' : autosave.state === 'saved' ? 'Saved' : autosave.state === 'error' ? 'Not saved' : ''}
            </span>
          }
          status={
            <>
              {loadError !== '' ? <ErrorBox>{loadError}</ErrorBox> : null}
              {autosave.error !== '' ? <ErrorBox>{autosave.error}</ErrorBox> : null}
              {!ready && loadError === '' ? <Loading label="Rendering pages…" /> : null}
            </>
          }
          rightPanelBottom={
            <>
              <section className="fpe-section">
                <h2 className="fpe-h">Readiness</h2>
                {readiness.items.map((it) => (
                  <div key={it.t} className="sg-check" style={{ fontSize: 13 }}>
                    <span className={it.ok ? 'sg-check__ok' : 'sg-check__no'} aria-hidden="true">
                      {it.ok ? '✓' : '!'}
                    </span>
                    {it.t}
                  </div>
                ))}
              </section>
              <section className="fpe-section">
                <Btn block disabled title="Previewing as a recipient needs a sender-scoped preview session (proposed)">
                  Preview as recipient · Proposed
                </Btn>
              </section>
            </>
          }
        />
      </div>
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(back)}>
          <Icon name="back" size={14} /> Back
        </Btn>
        <Btn variant="primary" onClick={() => nav(next)} disabled={autosave.state === 'saving'} data-testid="prepare-review">
          Review <Icon name="next" size={14} />
        </Btn>
      </div>
    </>
  );
}
