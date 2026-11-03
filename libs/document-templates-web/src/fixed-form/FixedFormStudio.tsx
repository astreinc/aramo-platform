import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ProductTagsSelect, templateProductsLine, type TemplateProductKey } from '../template-products';
import { type LoadedPdf } from '../pdf';

import { FixedFormCanvas } from './FixedFormCanvas';
import {
  FIXED_FORM_FIELD_TYPES,
  FIXED_FORM_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  fixedFormFieldLabel,
  nextFieldKey,
  roleKeyFromLabel,
  type FixedFormField,
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
  uploadPdf(versionId: string, content_base64: string): Promise<FixedFormVersionView>;
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
  loadPdfFn,
}: FixedFormStudioProps) {
  const [template, setTemplate] = useState<FixedFormStudioTemplate | null>(null);
  const [typeProducts, setTypeProducts] = useState<readonly TemplateProductKey[]>([]);
  const [view, setView] = useState<FixedFormVersionView | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [roles, setRoles] = useState<FixedFormRole[]>([]);
  const [routing, setRouting] = useState<'PARALLEL' | 'SEQUENTIAL'>('PARALLEL');
  const [fields, setFields] = useState<FixedFormField[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<string>('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkIssues, setCheckIssues] = useState<FixedFormIssue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const adopt = useCallback((v: FixedFormVersionView) => {
    setView(v);
    setRoles([...v.content.signing.roles]);
    setRouting(v.content.signing.routing_mode);
    setFields([...v.fields]);
    setDirty(false);
    setActiveRole((cur) => (v.content.signing.roles.some((r) => r.role_key === cur) ? cur : (v.content.signing.roles.find((r) => r.kind === 'SIGNER')?.role_key ?? '')));
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

  const editable = canManage && view?.status === 'DRAFT';
  const variables = useMemo(() => new Map((view?.variables ?? []).map((v) => [v.key, v])), [view]);
  const sel = fields.find((f) => f.field_key === selected) ?? null;
  const pages = view?.content.pdf?.pages ?? [];
  const published = template?.current_version !== null && template?.current_version !== undefined;

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

  const edit = (next: FixedFormField[]) => {
    setFields(next);
    setDirty(true);
    setCheckIssues(null);
  };

  function addField(type: string) {
    const page0 = pages[page] ?? pages[0];
    if (page0 === undefined) return;
    const spec = FIXED_FORM_FIELD_TYPES.find((t) => t.type === type);
    const width = spec?.width ?? 120;
    const height = spec?.height ?? 18;
    const field_key = nextFieldKey(type, fields);
    const offset = (fields.filter((f) => f.page_number === page).length % 10) * 12;
    const f: FixedFormField = {
      field_key,
      field_type: type,
      binding_key: null,
      signer_role: activeRole === '' ? null : activeRole,
      required: type !== 'CHECKBOX',
      page_number: pages[page] !== undefined ? page : 0,
      x: Math.min(72 + offset, Math.max(0, page0.width - width)),
      y: Math.max(0, page0.height - 144 - offset - height),
      width,
      height,
      ordinal: fields.length,
    };
    edit([...fields, f]);
    setSelected(field_key);
  }

  function updateSelected(patch: Partial<FixedFormField>) {
    if (sel === null) return;
    edit(fields.map((f) => (f.field_key === sel.field_key ? { ...f, ...patch } : f)));
  }

  function setRolesEdited(next: FixedFormRole[]) {
    setRoles(next.map((r, i) => ({ ...r, order: i + 1 })));
    setDirty(true);
    setCheckIssues(null);
  }

  async function onUpload(file: File) {
    if (view === null) return;
    if (file.size > FIXED_FORM_MAX_BYTES) {
      setError('The PDF is larger than 10 MB.');
      return;
    }
    await act('upload', async () => {
      const b64 = bytesToBase64(await file.arrayBuffer());
      const v = await ds.uploadPdf(view.version_id, b64);
      adopt(v);
      await loadPdfBytes(v);
    });
  }

  const save = () =>
    act('save', async () => {
      if (view === null) return;
      adopt(await ds.saveLayout(view.version_id, { signing: { roles, routing_mode: routing }, fields: fields.map((f, i) => ({ ...f, ordinal: i })) }));
    });

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
            <button type="button" className="ffs-btn" disabled={busy !== null || !dirty} onClick={() => void save()}>
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

      <div className="ffs-body">
        <aside className="ffs-panel" aria-label="Form setup">
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
              <p className="ffs-note">PDF only, up to 10 MB, no scripts or embedded files.</p>
            </>
          ) : null}

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
                  disabled={roles.length <= 1 || fields.some((f) => f.signer_role === r.role_key)}
                  title={fields.some((f) => f.signer_role === r.role_key) ? 'Move or delete its fields first' : undefined}
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
                setDirty(true);
              }}
            >
              <option value="PARALLEL">Any order</option>
              <option value="SEQUENTIAL">In role order</option>
            </select>
          </div>

          {editable ? (
            <>
              <h2>Place a field</h2>
              <div className="ffs-row">
                <label htmlFor="ffs-active-role">For</label>
                <select id="ffs-active-role" className="ffs-select" value={activeRole} onChange={(e) => setActiveRole(e.target.value)}>
                  {roles
                    .filter((r) => r.kind === 'SIGNER')
                    .map((r) => (
                      <option key={r.role_key} value={r.role_key}>
                        {r.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="ffs-palette">
                {FIXED_FORM_FIELD_TYPES.map((t) => (
                  <button key={t.type} type="button" className="ffs-btn" disabled={pages.length === 0} onClick={() => addField(t.type)} data-testid={`ffs-add-${t.type}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="ffs-note">Fields are added to page {page + 1}. Drag to move; drag the corner to resize.</p>
            </>
          ) : null}
        </aside>

        <main className="ffs-center" aria-label="Form pages">
          {view === null ? (
            <div className="ffs-empty">This form has no version yet.</div>
          ) : (
            <FixedFormCanvas
              pdfBytes={pdfBytes}
              fields={fields}
              roles={roles}
              selected={selected}
              editable={editable}
              onSelect={setSelected}
              onChange={edit}
              onPage={setPage}
              variableLabel={(k) => `Prefilled: ${variables.get(k)?.label ?? k}`}
              {...(loadPdfFn !== undefined ? { loadPdfFn } : {})}
            />
          )}
        </main>

        <aside className="ffs-panel ffs-panel--right" aria-label="Field and checks">
          <h2>Field</h2>
          {sel === null ? (
            <p className="ffs-note">Select a field on the form.</p>
          ) : (
            <div data-testid="ffs-inspector">
              <p className="ffs-note">
                {fixedFormFieldLabel(sel.field_type)} · <code>{sel.field_key}</code> · page {(sel.page_number ?? 0) + 1}
              </p>
              <div className="ffs-row">
                <label htmlFor="ffs-field-owner">Filled by</label>
                <select
                  id="ffs-field-owner"
                  className="ffs-select"
                  disabled={!editable}
                  value={sel.binding_key !== null ? `var:${sel.binding_key}` : `role:${sel.signer_role ?? ''}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v.startsWith('var:')) updateSelected({ binding_key: v.slice(4), signer_role: null });
                    else updateSelected({ binding_key: null, signer_role: v.slice(5) || null });
                  }}
                >
                  {roles
                    .filter((r) => r.kind === 'SIGNER')
                    .map((r) => (
                      <option key={r.role_key} value={`role:${r.role_key}`}>
                        {r.label}
                      </option>
                    ))}
                  {sel.field_type === 'TEXT'
                    ? [...variables.values()].map((v) => (
                        <option key={v.key} value={`var:${v.key}`}>
                          Prefilled: {v.label}
                        </option>
                      ))
                    : null}
                </select>
              </div>
              <label className="ffs-row">
                <input type="checkbox" checked={sel.required} disabled={!editable || sel.binding_key !== null} onChange={(e) => updateSelected({ required: e.target.checked })} />
                Required
              </label>
              {editable ? (
                <button
                  type="button"
                  className="ffs-btn ffs-btn--danger"
                  onClick={() => {
                    edit(fields.filter((f) => f.field_key !== sel.field_key));
                    setSelected(null);
                  }}
                >
                  Delete field
                </button>
              ) : null}
            </div>
          )}

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
        </aside>
      </div>
    </div>
  );
}
