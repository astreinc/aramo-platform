import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FieldImportResult,
  NO_UPLOAD_FIELD_OPTIONS,
  PlacementEditor,
  UploadFieldOptions,
  suggestionsFromWire,
  uploadFlags,
  useAutosave,
  type PlacedField,
  type UploadFieldOptionsValue,
} from '@aramo/field-placement-web';
import { FIELD_GROUP_KEY_MAX, FIELD_LABEL_MAX, attachmentsRemovedNotice } from '@aramo/sign-fields';

import { ProductTagsSelect, templateProductsLine, type TemplateProductKey } from '../template-products';
import { loadPdf as defaultLoadPdf, type LoadedPdf } from '../pdf';

import { FIXED_FORM_DOC_ID, FIXED_FORM_EDITOR_COPY, FIXED_FORM_PALETTE, fixedFormFieldsToWire, fixedFormSettings, fixedFormFieldsToPlaced } from './fixed-form-placement';
import {
  FIXED_FORM_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  nextFieldKey,
  roleKeyFromLabel,
  type FixedFormField,
  type FixedFormFieldImport,
  type FixedFormFieldSuggestions,
  type FixedFormIssue,
  type FixedFormRole,
  type FixedFormVersionView,
} from './fixed-form-model';
import './fixed-form.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.2 — the Platform Studio's
// fixed-form mode, for an Aramo default of a FIXED_FORM document type: upload the official
// PDF, define the signer roles, place fields over the rendered pages by role (text, date,
// checkbox, name, signature, initials — what Aramo Sign executes; a text field may instead be
// prefilled by a variable), check, publish and withdraw like any default. A new issuer edition
// is a new version (the draft starts from the current one; upload the new PDF on it).
//
// FIELD-PARITY-1 P1-5 (ruling R-8) — the palette, page column, field panel, keyboard map, undo
// and the P0-1 viewport behaviour are the ONE shared placement editor (@aramo/field-placement-web,
// the same one sign-web Prepare uses). This Studio keeps its chrome (top bar: Save, Check,
// Publish, Discard, Withdraw; form setup; checks) and its data source calls; the layout also
// saves automatically 600ms after an edit (the same rule as Prepare), through saveLayout.
//
// The host supplies the data source (platform-web: /platform/document-templates*). The server
// is authoritative for every rule; the Studio shows its issue list and refusals.

export interface FixedFormStudioTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly products: readonly string[];
  readonly document_type_id: string;
  readonly current_version: { readonly id: string; readonly version_number: number; readonly status: string } | null;
  readonly draft_version_id: string | null;
  readonly withdraw_effective_at: string | null;
}

export interface FixedFormStudioDataSource {
  loadTemplate(id: string): Promise<FixedFormStudioTemplate>;
  /** The products a template of this type may carry (TP-3 §2.7). */
  typeProducts(document_type_id: string): Promise<readonly TemplateProductKey[]>;
  view(versionId: string): Promise<FixedFormVersionView>;
  pdf(versionId: string): Promise<{ content_base64: string }>;
  createDraft(templateId: string): Promise<FixedFormVersionView>;
  /**
   * FIELD-PARITY-1 P2-5 / P2-6 — `options` carries only the ticked upload flags (none: the upload
   * is unchanged); the answer then has `field_import`.
   */
  uploadPdf(versionId: string, content_base64: string, options?: { import_fields?: true; apply_text_tags?: true }): Promise<FixedFormVersionView>;
  /** FIELD-PARITY-1 P2-4 — the detector's suggestions for the version's PDF ("Find fields"). */
  fieldSuggestions?(versionId: string): Promise<FixedFormFieldSuggestions>;
  saveLayout(
    versionId: string,
    body: { signing: { roles: readonly FixedFormRole[]; routing_mode: 'PARALLEL' | 'SEQUENTIAL' }; fields: readonly FixedFormField[] },
  ): Promise<FixedFormVersionView>;
  preview(versionId: string): Promise<FixedFormVersionView>;
  publish(versionId: string): Promise<unknown>;
  discardDraft?(versionId: string): Promise<void>;
  updateProducts?(templateId: string, products: readonly string[]): Promise<unknown>;
  withdraw?(templateId: string, body: { notice_days: number; reason: string | null }): Promise<unknown>;
}

export interface FixedFormStudioProps {
  readonly dataSource: FixedFormStudioDataSource;
  readonly templateId: string;
  readonly canManage: boolean;
  readonly backHref?: string;
  readonly renderAccount?: () => ReactNode;
  readonly onEntityName?: (name: string) => void;
  readonly formatError?: (e: unknown, fallback: string) => string;
  /** Injected in tests (pdf.js does not run under jsdom). */
  readonly loadPdfFn?: (bytes: ArrayBuffer) => Promise<LoadedPdf>;
}

const defaultFormat = (e: unknown, fallback: string): string => (e instanceof Error && e.message !== '' ? e.message : fallback);

function issuesOf(e: unknown): FixedFormIssue[] {
  const details = (e as { details?: Record<string, unknown> } | null)?.details;
  const raw = details?.['issues'];
  return Array.isArray(raw) ? (raw as FixedFormIssue[]) : [];
}

export function FixedFormStudio({
  dataSource: ds,
  templateId,
  canManage,
  backHref = '/document-templates',
  renderAccount,
  onEntityName,
  formatError = defaultFormat,
  loadPdfFn = defaultLoadPdf,
}: FixedFormStudioProps) {
  const [template, setTemplate] = useState<FixedFormStudioTemplate | null>(null);
  const [typeProducts, setTypeProducts] = useState<readonly TemplateProductKey[]>([]);
  const [view, setView] = useState<FixedFormVersionView | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [roles, setRoles] = useState<FixedFormRole[]>([]);
  const [routing, setRouting] = useState<'PARALLEL' | 'SEQUENTIAL'>('PARALLEL');
  // FIELD-PARITY-1 P1-5 — the fields as the shared editor last reported them; `stored` keeps the
  // server's objects so an unchanged field goes back exactly as read.
  const [placed, setPlaced] = useState<readonly PlacedField[]>([]);
  const [stored, setStored] = useState<ReadonlyMap<string, FixedFormField>>(new Map());
  const [loadKey, setLoadKey] = useState(0);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkIssues, setCheckIssues] = useState<FixedFormIssue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // FIELD-PARITY-1 P2-5 / P2-6 — the upload options (off by default) and the last import's result.
  const [uploadOpts, setUploadOpts] = useState<UploadFieldOptionsValue>(NO_UPLOAD_FIELD_OPTIONS);
  const [importResult, setImportResult] = useState<FixedFormFieldImport | null>(null);
  // PDF-ATTACH-1 ATT-8 — the shared notice when the upload's attached files were removed.
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);

  // Replaces the whole working copy (load, upload, new draft, publish) — the editor resets.
  const adopt = useCallback((v: FixedFormVersionView) => {
    setView(v);
    setRoles([...v.content.signing.roles]);
    setRouting(v.content.signing.routing_mode);
    setPlaced(fixedFormFieldsToPlaced(v.fields));
    setStored(new Map(v.fields.map((f) => [f.field_key, f])));
    setLoadKey((k) => k + 1);
    setDirty(false);
  }, []);

  const loadPdfBytes = useCallback(
    async (v: FixedFormVersionView) => {
      if (v.content.pdf === null) {
        setPdfBytes(null);
        return;
      }
      const out = await ds.pdf(v.version_id);
      setPdfBytes(base64ToBytes(out.content_base64));
    },
    [ds],
  );

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const t = await ds.loadTemplate(templateId);
      setTemplate(t);
      onEntityName?.(t.name);
      setTypeProducts(await ds.typeProducts(t.document_type_id).catch(() => []));
      const versionId = t.draft_version_id ?? t.current_version?.id ?? null;
      if (versionId === null) {
        setView(null);
        setPdfBytes(null);
        return;
      }
      const v = await ds.view(versionId);
      adopt(v);
      await loadPdfBytes(v);
    } catch (e) {
      setLoadError(formatError(e, 'Could not load this form.'));
    }
  }, [ds, templateId, onEntityName, adopt, loadPdfBytes, formatError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The official PDF, loaded once per upload (pdf.js, lazily).
  useEffect(() => {
    let live = true;
    let loaded: LoadedPdf | null = null;
    setPdf(null);
    setPdfFailed(false);
    if (pdfBytes === null) return undefined;
    loadPdfFn(pdfBytes).then(
      (doc) => {
        loaded = doc;
        if (live) setPdf(doc);
        else doc.destroy();
      },
      () => {
        if (live) setPdfFailed(true);
      },
    );
    return () => {
      live = false;
      loaded?.destroy();
    };
  }, [pdfBytes, loadPdfFn]);

  const editable = canManage && view?.status === 'DRAFT';
  const published = template?.current_version !== null && template?.current_version !== undefined;
  const documents = useMemo(() => (pdf === null ? [] : [{ id: FIXED_FORM_DOC_ID, title: view?.content.title ?? '', pages: pdf.pages }]), [pdf, view?.content.title]);
  const renderPage = useCallback((_doc: string, index: number, canvas: HTMLCanvasElement, width: number) => pdf?.render(index, canvas, width) ?? Promise.resolve(), [pdf]);
  const assignees = useMemo(() => roles.filter((r) => r.kind === 'SIGNER').map((r) => ({ id: r.role_key, label: r.label })), [roles]);
  const prefills = useMemo(() => (view?.variables ?? []).map((v) => ({ key: v.key, label: v.label })), [view]);
  const senderFilledOn = view?.sender_filled_fields_enabled === true;
  const capabilities = useMemo(
    () => ({ settings: fixedFormSettings({ sender_filled_fields_enabled: senderFilledOn }), prefillTypes: ['TEXT'], limits: { labelMax: FIELD_LABEL_MAX, groupKeyMax: FIELD_GROUP_KEY_MAX } }),
    [senderFilledOn],
  );
  // FIELD-PARITY-1 P2-4 — "Find fields" on a draft with a PDF (the console's fixed-form route).
  const versionId = view?.version_id ?? null;
  const hasPdf = view?.content.pdf != null;
  const loadSuggestions = useMemo(() => {
    const get = ds.fieldSuggestions;
    if (get === undefined || versionId === null || !hasPdf) return undefined;
    return async () => suggestionsFromWire(FIXED_FORM_DOC_ID, (await get.call(ds, versionId)).suggestions);
  }, [ds, versionId, hasPdf]);

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(formatError(e, 'That did not work.'));
      const issues = issuesOf(e);
      if (issues.length > 0) setCheckIssues(issues);
    } finally {
      setBusy(null);
    }
  }

  const edited = () => {
    setDirty(true);
    setCheckIssues(null);
    setRevision((r) => r + 1);
  };

  // The layout save (autosave and the Save button): the same saveLayout body as before P1-5.
  // The response refreshes the issues / previewed state; the working copy is kept (an edit made
  // while the save was in flight is not overwritten), and stays dirty if one was.
  const latest = useRef({ view, roles, routing, placed, stored, revision });
  latest.current = { view, roles, routing, placed, stored, revision };
  const saveLayout = useCallback(async () => {
    const cur = latest.current;
    if (cur.view === null) return;
    setBusy('save');
    setError(null);
    try {
      const v = await ds.saveLayout(cur.view.version_id, { signing: { roles: cur.roles, routing_mode: cur.routing }, fields: fixedFormFieldsToWire(cur.placed, cur.stored) });
      setView(v);
      if (latest.current.revision === cur.revision) setDirty(false);
    } catch (e) {
      setError(formatError(e, 'That did not work.'));
      const issues = issuesOf(e);
      if (issues.length > 0) setCheckIssues(issues);
      throw e;
    } finally {
      setBusy(null);
    }
  }, [ds, formatError]);
  const autosave = useAutosave({ revision, enabled: editable, save: saveLayout, formatError: (e) => formatError(e, 'Not saved.') });

  function setRolesEdited(next: FixedFormRole[]) {
    setRoles(next.map((r, i) => ({ ...r, order: i + 1 })));
    edited();
  }

  async function onUpload(file: File) {
    if (view === null) return;
    if (file.size > FIXED_FORM_MAX_BYTES) {
      setError('The PDF is larger than 10 MB.');
      return;
    }
    setImportResult(null);
    setAttachmentNotice(null);
    await act('upload', async () => {
      const b64 = bytesToBase64(await file.arrayBuffer());
      const flags = uploadFlags(uploadOpts);
      const v = Object.keys(flags).length > 0 ? await ds.uploadPdf(view.version_id, b64, flags) : await ds.uploadPdf(view.version_id, b64);
      adopt(v);
      setImportResult(v.field_import ?? null);
      setAttachmentNotice(attachmentsRemovedNotice(v.attachments_removed));
      await loadPdfBytes(v);
    });
  }

  if (loadError !== null) {
    return (
      <div className="ffs-root" data-testid="fixed-form-studio">
        <div className="ffs-center">
          <p className="ffs-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="ffs-btn" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (template === null) return <div className="ffs-root ffs-center" data-testid="fixed-form-studio">Loading…</div>;

  const statusLine =
    view === null
      ? 'No version yet'
      : `v${view.version_number} · ${view.status === 'DRAFT' ? 'Draft' : view.status === 'ACTIVE' ? 'Published' : 'Retired'}`;

  const empty =
    view === null ? (
      <div className="ffs-empty">This form has no version yet.</div>
    ) : pdfBytes === null ? (
      <div className="ffs-empty">No PDF yet. Upload the official form to place fields on it.</div>
    ) : pdfFailed ? (
      <div className="ffs-empty" role="alert">
        The PDF could not be displayed.
      </div>
    ) : (
      <div className="ffs-empty">Loading the form…</div>
    );

  const setup = (
    <>
      <h2>Official PDF</h2>
      {view?.content.pdf != null ? (
        <p className="ffs-note" data-testid="ffs-pdf-meta">
          {view.content.pdf.page_count} page{view.content.pdf.page_count === 1 ? '' : 's'} · {(view.content.pdf.byte_size / 1024).toFixed(0)} KB
        </p>
      ) : (
        <p className="ffs-note">No PDF uploaded.</p>
      )}
      {editable ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            data-testid="ffs-upload-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file !== undefined) void onUpload(file);
            }}
          />
          <button type="button" className="ffs-btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            {view?.content.pdf != null ? 'Replace PDF…' : 'Upload PDF…'}
          </button>
          <p className="ffs-note">PDF only, up to 10 MB, no scripts. Attached files are removed.</p>
          <UploadFieldOptions value={uploadOpts} onChange={setUploadOpts} disabled={busy !== null} idPrefix="ffs" />
        </>
      ) : null}
      {attachmentNotice !== null ? (
        <p className="ffs-note" role="status" data-testid="ffs-attachments-removed">
          {attachmentNotice}
        </p>
      ) : null}
      {importResult !== null ? <FieldImportResult result={importResult} idPrefix="ffs" onClose={() => setImportResult(null)} /> : null}

      <h2>Product tags</h2>
      {canManage && ds.updateProducts !== undefined ? (
        <ProductTagsSelect
          label="Used in"
          value={template.products}
          options={typeProducts}
          helper="At least one is needed to publish."
          onChange={(next) =>
            void act('tags', async () => {
              await ds.updateProducts!(template.id, next);
              setTemplate({ ...template, products: next });
            })
          }
        />
      ) : (
        <p className="ffs-note">{templateProductsLine(template.products) || 'None'}</p>
      )}

      <h2>Signer roles</h2>
      {roles.map((r, i) => (
        <div className="ffs-row" key={r.role_key}>
          <input
            type="text"
            aria-label={`Role ${i + 1} name`}
            value={r.label}
            disabled={!editable}
            onChange={(e) => setRolesEdited(roles.map((x) => (x.role_key === r.role_key ? { ...x, label: e.target.value } : x)))}
          />
          <select
            aria-label={`Role ${i + 1} kind`}
            className="ffs-select"
            value={r.kind}
            disabled={!editable}
            onChange={(e) => setRolesEdited(roles.map((x) => (x.role_key === r.role_key ? { ...x, kind: e.target.value as 'SIGNER' | 'CC' } : x)))}
          >
            <option value="SIGNER">Signs</option>
            <option value="CC">Gets a copy</option>
          </select>
          {editable ? (
            <button
              type="button"
              className="ffs-btn ffs-btn--danger"
              aria-label={`Remove role ${r.label}`}
              disabled={roles.length <= 1 || placed.some((f) => f.assignee === r.role_key)}
              title={placed.some((f) => f.assignee === r.role_key) ? 'Move or delete its fields first' : undefined}
              onClick={() => setRolesEdited(roles.filter((x) => x.role_key !== r.role_key))}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      {editable ? (
        <button
          type="button"
          className="ffs-btn"
          disabled={roles.length >= 20}
          onClick={() => {
            const label = `Signer ${roles.filter((r) => r.kind === 'SIGNER').length + 1}`;
            const role_key = roleKeyFromLabel(label, new Set(roles.map((r) => r.role_key)));
            setRolesEdited([...roles, { role_key, label, kind: 'SIGNER', order: roles.length + 1 }]);
          }}
        >
          Add role
        </button>
      ) : null}
      <div className="ffs-row" style={{ marginTop: 8 }}>
        <label htmlFor="ffs-routing">Signing order</label>
        <select
          id="ffs-routing"
          className="ffs-select"
          value={routing}
          disabled={!editable}
          onChange={(e) => {
            setRouting(e.target.value as 'PARALLEL' | 'SEQUENTIAL');
            edited();
          }}
        >
          <option value="PARALLEL">Any order</option>
          <option value="SEQUENTIAL">In role order</option>
        </select>
      </div>
    </>
  );

  const checks = (
    <section className="fpe-section">
      <h2>Checks</h2>
      {dirty ? <p className="ffs-note">Unsaved changes — save, then check.</p> : null}
      {(() => {
        const list = checkIssues ?? (dirty ? [] : (view?.issues ?? []));
        if (view === null) return null;
        if (!dirty && list.length === 0) {
          return <p className="ffs-ok">{view.previewed ? 'Checked. Ready to publish.' : 'No problems found. Check the form before publishing.'}</p>;
        }
        return (
          <ul className="ffs-issues" data-testid="ffs-issues">
            {list.map((i, n) => (
              <li key={`${i.code}-${i.field_key ?? i.role_key ?? n}`}>{i.message}</li>
            ))}
          </ul>
        );
      })()}
      {template.products.length === 0 ? <p className="ffs-note">Add a product tag before publishing.</p> : null}
    </section>
  );

  return (
    <div className="ffs-root" data-testid="fixed-form-studio">
      <header className="ffs-top">
        <a className="ffs-btn" href={backHref}>
          ← Document templates
        </a>
        <span className="ffs-top__title">{template.name}</span>
        <span className="ffs-top__meta">Fixed form · {statusLine}</span>
        {template.withdraw_effective_at !== null ? <span className="ffs-top__meta">Withdrawal published</span> : null}
        <span className="ffs-top__spacer" />
        {canManage && view === null ? (
          <button type="button" className="ffs-btn ffs-btn--primary" disabled={busy !== null} onClick={() => void act('draft', async () => { adopt(await ds.createDraft(template.id)); await reload(); })}>
            Start the first version
          </button>
        ) : null}
        {canManage && view !== null && view.status !== 'DRAFT' && template.draft_version_id === null && template.withdraw_effective_at === null ? (
          <button type="button" className="ffs-btn" disabled={busy !== null} onClick={() => void act('draft', async () => { await ds.createDraft(template.id); await reload(); })}>
            New version
          </button>
        ) : null}
        {editable ? (
          <>
            <button type="button" className="ffs-btn" disabled={busy !== null || !dirty} onClick={() => void autosave.flush()}>
              Save
            </button>
            <button
              type="button"
              className="ffs-btn"
              disabled={busy !== null || dirty}
              title={dirty ? 'Save first' : undefined}
              onClick={() =>
                void act('check', async () => {
                  setCheckIssues(null);
                  adopt(await ds.preview(view!.version_id));
                  setCheckIssues([]);
                })
              }
            >
              Check
            </button>
            <button
              type="button"
              className="ffs-btn ffs-btn--primary"
              disabled={busy !== null || dirty || view?.previewed !== true}
              title={view?.previewed !== true ? 'Check the form first' : undefined}
              onClick={() =>
                void act('publish', async () => {
                  await ds.publish(view!.version_id);
                  await reload();
                })
              }
            >
              Publish
            </button>
            {ds.discardDraft !== undefined ? (
              <button
                type="button"
                className="ffs-btn ffs-btn--danger"
                disabled={busy !== null}
                onClick={() => {
                  if (typeof window !== 'undefined' && !window.confirm('Discard this draft? Its PDF and fields are removed.')) return;
                  void act('discard', async () => {
                    await ds.discardDraft!(view!.version_id);
                    await reload();
                  });
                }}
              >
                Discard draft
              </button>
            ) : null}
          </>
        ) : null}
        {canManage && published && template.withdraw_effective_at === null && ds.withdraw !== undefined ? (
          <button
            type="button"
            className="ffs-btn ffs-btn--danger"
            disabled={busy !== null}
            onClick={() => {
              if (typeof window !== 'undefined' && !window.confirm('Withdraw this form? Tenants stop seeing it in 7 days.')) return;
              void act('withdraw', async () => {
                await ds.withdraw!(template.id, { notice_days: 7, reason: null });
                await reload();
              });
            }}
          >
            Withdraw…
          </button>
        ) : null}
        {renderAccount?.()}
      </header>

      {error !== null ? (
        <p className="ffs-error" role="alert" style={{ padding: '0 16px' }}>
          {error}
        </p>
      ) : null}

      <PlacementEditor
        documents={documents}
        renderPage={renderPage}
        surface="template_fixed_form"
        palette={FIXED_FORM_PALETTE}
        fields={placed}
        resetKey={loadKey}
        onChange={(next) => {
          setPlaced(next);
          edited();
        }}
        assignees={assignees}
        allowUnassigned
        prefills={prefills}
        // FIELD-PARITY-1 P1-3 / P3 — the template API stores every field setting (the server's
        // rule: @aramo/sign-fields parseTemplateFieldSettings); the editor offers them per type.
        // FIELD-PARITY-2 A-4 — Sender-filled and Read-only only while the view says the server
        // flag is on (fixedFormSettings; they ship dark).
        capabilities={capabilities}
        readOnly={!editable}
        newFieldId={(type, fields) => nextFieldKey(type, fields.map((f) => ({ field_key: f.id })))}
        paletteMode="add"
        precision="hundredths"
        pageWidth={720}
        idPrefix="ffs"
        copy={FIXED_FORM_EDITOR_COPY}
        leftPanelTop={setup}
        rightPanelBottom={checks}
        toolbarEnd={
          editable ? (
            <span className="ffs-note" role="status" data-testid="ffs-save-state">
              {autosave.state === 'saving' ? 'Saving…' : autosave.state === 'saved' ? 'Saved' : autosave.state === 'error' ? 'Not saved' : ''}
            </span>
          ) : null
        }
        empty={empty}
        showFieldKey
        {...(editable && loadSuggestions !== undefined ? { loadSuggestions } : {})}
      />
    </div>
  );
}
