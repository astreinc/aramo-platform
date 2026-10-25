import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, Button, Input, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { ChainPreview, CommercialRequestDialog, RequestField, SkeletonPanel, shortId, type CommercialDiffRow } from '../../components';
import { COMMERCIAL_PERMISSIONS as CP } from '../../components/permissions';

import { catalogApi, type Catalog, type CatalogActionType, type CatalogPlan, type CatalogVersion } from './catalog-api';
import {
  CATALOG_PRODUCTS,
  NO_PLANS_LINE,
  REQUEST_STATE_LABEL,
  STEP_LABEL,
  V1_LOCK_TITLE,
  chainLabelOf,
  chipPinned,
  draftDiff,
  editorOf,
  grandfatheringLine,
  applyActionOf,
  lastPublished,
  openRequestOf,
  openRequestSentence,
  parseFieldInput,
  pinnedLine,
  planRow,
  versionActions,
  versionTitle,
  versionsAscending,
  VERSION_PILL,
  type EditorFieldKey,
} from './catalog-model';
import './catalog.css';

// CCP-B2 (Program Build Directive §5.3 row B2; CCP handoff §5.4) — the product and plan catalog
// at /commercial/catalog. Products (the `sign` registry; ATS, Portal and Intelligence have no
// plans), Sign plans with their versions (Draft / Published / Retired), the pin counts and the
// grandfathering line, the v1 locks, and the actions:
//   - a catalog manager (platform:catalog:draft) creates a DRAFT from a version and edits it
//     (price, envelopes per month, storage; saved when a field loses focus);
//   - "Request publish…" / "Request retire…" create a PLAN_VERSION_PUBLISH / PLAN_RETIRE change
//     request and submit it (Finance → Owner). The console never publishes or retires;
//   - a PUBLISHED or RETIRED version is read-only: no field is editable and no edit action exists.
// Other roles see the view-only note; their buttons are disabled with the reason as a tooltip.

const PUBLISH_INTRO =
  'Products, their plans and plan versions. A published version never changes: subscriptions pin it, and edits happen in a new draft that Finance and an Owner approve before it publishes.';

type DialogState = { kind: 'publish' | 'retire'; plan: CatalogPlan; version: CatalogVersion } | null;

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message;
  return fallback;
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return `catalog-${c?.randomUUID ? c.randomUUID() : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`}`;
}

export function CatalogView({ session }: { readonly session: Session }) {
  const canDraft = hasScope(session, CP.catalogDraft);
  const toast = useOptionalToast();
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tenantNames, setTenantNames] = useState<Record<string, readonly string[]>>({});
  const [inputs, setInputs] = useState<Partial<Record<EditorFieldKey, string>>>({});
  const [invalid, setInvalid] = useState<EditorFieldKey | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [typed, setTyped] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const saving = useRef<Promise<unknown> | null>(null);
  // The latest render's version, so a queued save sends the checksum the previous save left.
  const latest = useRef<CatalogVersion | undefined>(undefined);

  const load = useCallback(async (): Promise<Catalog | null> => {
    setLoadError(null);
    try {
      const c = await catalogApi.getCatalog();
      setCatalog(c);
      return c;
    } catch (e) {
      setLoadError(errorText(e, 'The catalog couldn’t be loaded. Try again.'));
      return null;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const product = params.get('product') ?? 'sign';
  const registry = catalog?.products ?? [];
  const plans = registry.find((p) => p.product_key === product)?.plans ?? [];
  const plan = plans.find((p) => p.id === params.get('plan')) ?? plans[0];
  const asc = plan ? versionsAscending(plan) : [];
  const wanted = Number(params.get('version'));
  const version = asc.find((v) => v.version_number === wanted) ?? asc.at(-1);
  latest.current = version;

  // Pinned tenant names for the selected (non-draft) version.
  useEffect(() => {
    if (!version || version.status === 'DRAFT' || tenantNames[version.id] !== undefined) return;
    let live = true;
    catalogApi
      .getVersion(version.id)
      .then((d) => {
        if (live) setTenantNames((m) => ({ ...m, [version.id]: d.pinned_tenants.map((t) => t.name) }));
      })
      .catch(() => {
        if (live) setTenantNames((m) => ({ ...m, [version.id]: [] }));
      });
    return () => {
      live = false;
    };
  }, [version, tenantNames]);

  // CCP-A6-R (TD-B2-3, requester-only) — the Apply action shows only when the server says this
  // caller may apply the open request now (`apply_actionable`). Merge train TD-MERGE-9.
  const [applyActionable, setApplyActionable] = useState<Readonly<Record<string, boolean>>>({});
  const openForApply = version ? openRequestOf(version) : null;
  const openApplyId = openForApply !== null && applyActionOf(openForApply) !== null ? openForApply.id : null;
  useEffect(() => {
    if (openApplyId === null) return;
    let live = true;
    catalogApi
      .isApplyActionable(openApplyId)
      .then((ok) => {
        if (live) setApplyActionable((m) => ({ ...m, [openApplyId]: ok }));
      })
      .catch(() => {
        if (live) setApplyActionable((m) => ({ ...m, [openApplyId]: false }));
      });
    return () => {
      live = false;
    };
  }, [openApplyId, catalog]);

  // A different version → fresh editor inputs.
  const versionId = version?.id;
  useEffect(() => {
    setInputs({});
    setInvalid(null);
    setSaveError(null);
    setActionError(null);
  }, [versionId]);

  const select = (next: { product?: string; plan?: string; version?: number }): void => {
    const p = new URLSearchParams(params);
    if (next.product !== undefined) {
      if (next.product === 'sign') p.delete('product');
      else p.set('product', next.product);
      p.delete('plan');
      p.delete('version');
    }
    if (next.plan !== undefined) {
      p.set('plan', next.plan);
      p.delete('version');
    }
    if (next.version !== undefined) p.set('version', String(next.version));
    setParams(p, { replace: true });
  };

  const editor = useMemo(() => (plan && version ? editorOf(plan, version, canDraft, inputs) : null), [plan, version, canDraft, inputs]);

  /** Saves one draft field when it loses focus (only a DRAFT seen by a catalog manager). */
  const saveField = async (key: Exclude<EditorFieldKey, 'seats'>): Promise<void> => {
    if (!version || version.status !== 'DRAFT' || !canDraft) return;
    const raw = inputs[key];
    if (raw === undefined) return;
    const parsed = parseFieldInput(key, raw);
    if (!parsed.ok) {
      setInvalid(key);
      return;
    }
    setInvalid(null);
    const field = key === 'price' ? 'list_price_minor' : key === 'envelopes' ? 'envelopes_per_month' : 'storage_bytes';
    const prior = saving.current;
    const run = (async () => {
      if (prior) await prior;
      const current = latest.current;
      if (!current || current.id !== version.id) return;
      try {
        await catalogApi.updateDraft(current.id, current.content_checksum, { [field]: parsed.value } as never);
        setSaveError(null);
        await load();
        setInputs((m) => {
          const rest = { ...m };
          delete rest[key];
          return rest;
        });
      } catch (e) {
        setSaveError(errorText(e, 'The draft couldn’t be saved. Try again.'));
      }
    })();
    saving.current = run;
    await run;
    if (saving.current === run) saving.current = null;
  };

  const createDraft = async (from: CatalogVersion): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setActionError(null);
    try {
      const out = await catalogApi.createDraft(plan.id, from.id);
      await load();
      select({ version: out.version.version_number });
      toast.show(`Draft v${String(out.version.version_number)} created. Published v${String(from.version_number)} is unchanged.`);
    } catch (e) {
      setActionError(errorText(e, 'The draft couldn’t be created. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const openDialog = async (kind: 'publish' | 'retire'): Promise<void> => {
    if (!plan || !version) return;
    if (saving.current) await saving.current;
    setReason('');
    setEvidence('');
    setTyped('');
    setDialogError(null);
    setDialog({ kind, plan, version });
  };

  const submitRequest = async (): Promise<void> => {
    if (dialog === null) return;
    const action_type: CatalogActionType = dialog.kind === 'publish' ? 'PLAN_VERSION_PUBLISH' : 'PLAN_RETIRE';
    setBusy(true);
    setDialogError(null);
    try {
      const req = await catalogApi.requestCatalogChange({
        action_type,
        plan_version_id: dialog.version.id,
        reason: reason.trim(),
        evidence: evidence.trim(),
        idempotency_key: newIdempotencyKey(),
      });
      setDialog(null);
      await load();
      const steps = req.required_chain.steps.map((s) => STEP_LABEL[s.role_key] ?? s.role_key).join(' → ');
      toast.show(`${shortId(req.id)} submitted · ${steps}`);
    } catch (e) {
      setDialogError(errorText(e, 'The request couldn’t be submitted. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  /** TD-A6-13 — execute an approved catalog request through the A6 apply route. */
  const applyRequest = async (id: string): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const req = await catalogApi.applyChangeRequest(id);
      await load();
      toast.show(`${shortId(req.id)} ${REQUEST_STATE_LABEL[req.state] ?? req.state.toLowerCase()}.`);
    } catch (e) {
      setActionError(errorText(e, 'The request couldn’t be applied. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const chain = catalog?.publish_chain ?? null;
  const chainNode = chain ? (
    <ChainPreview
      label={chainLabelOf(chain.rule)}
      steps={chain.step_role_keys.map((r) => STEP_LABEL[r] ?? r)}
      policy={`v${String(chain.policy_version_number)}`}
      window={`${String(chain.approval_expiry_hours)} h`}
    />
  ) : null;

  const dialogDiff: CommercialDiffRow[] = (() => {
    if (dialog === null) return [];
    if (dialog.kind === 'retire') return [{ field: versionTitle(dialog.plan, dialog.version), before: 'Published', after: 'Retired', changed: true }];
    const pub = lastPublished(dialog.plan, dialog.version);
    return pub ? draftDiff(pub.terms, dialog.version.terms, 'dialog') : [];
  })();

  return (
    <div className="pc-page">
      <div className="pc-head">
        <h1 className="pc-h1">Catalog</h1>
        <p className="pc-intro">{PUBLISH_INTRO}</p>
      </div>
      {!canDraft ? (
        <div className="pc-viewonly" role="note">
          <b>View only.</b>
          {' You can view the catalog. Drafting, publishing and retiring versions needs the '}
          <b>Catalog manager</b>
          {' role.'}
        </div>
      ) : null}

      {loadError !== null ? (
        <div className="pc-error" role="alert">
          {loadError}
          <Button unstyled type="button" className="pc-btn" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : catalog === null ? (
        <div className="pc-skeleton">
          <SkeletonPanel lines={['40%', '85%']} label="Loading the catalog…" />
          <SkeletonPanel lines={['60%', '85%', '70%', '78%']} label="Loading plans…" />
        </div>
      ) : (
        <>
          <div className="pc-products" role="group" aria-label="Products">
            {CATALOG_PRODUCTS.map((p) => {
              const own = registry.find((r) => r.product_key === p.key);
              const n = own?.plans.length ?? 0;
              return (
                <Button unstyled key={p.key} type="button" className="pc-product" aria-pressed={product === p.key} onClick={() => select({ product: p.key })}>
                  <div className="pc-product__name">{p.name}</div>
                  <div className="pc-product__sub">{n > 0 ? `${String(n)} plans` : NO_PLANS_LINE}</div>
                </Button>
              );
            })}
          </div>

          {plans.length === 0 || !plan || !version || !editor ? (
            <section className="pc-none">
              <b>{NO_PLANS_LINE}</b>
              <p>{`${CATALOG_PRODUCTS.find((p) => p.key === product)?.name ?? product} is granted as an entitlement only. Plans appear here once pricing is decided.`}</p>
            </section>
          ) : (
            <div className="pc-grid">
              <section className="pc-card" aria-labelledby="pc-plans-title">
                <div className="pc-card__head pc-card__head--row">
                  <h2 id="pc-plans-title" className="pc-card__title">
                    Aramo Sign plans
                  </h2>
                </div>
                {plans.map((pl) => {
                  const row = planRow(pl);
                  return (
                    <Button unstyled key={pl.id} type="button" className="pc-plan" aria-pressed={pl.id === plan.id} onClick={() => select({ plan: pl.id })}>
                      <span className="pc-plan__name">{row.title}</span>
                      <span className="pc-plan__price">{row.price}</span>
                      <span className="pc-plan__line">{row.versions}</span>
                      <span className="pc-plan__line pc-plan__line--end">{row.counts}</span>
                    </Button>
                  );
                })}
              </section>

              <section className="pc-card" aria-labelledby="pc-versions-title">
                <div className="pc-card__head">
                  <h2 id="pc-versions-title" className="pc-card__title">{`Sign ${plan.name} · versions`}</h2>
                  <p className="pc-card__sub">{grandfatheringLine(plan)}</p>
                </div>
                <div className="pc-chips" role="group" aria-label="Versions">
                  {asc.map((v) => (
                    <Button unstyled key={v.id} type="button" className="pc-chip" aria-pressed={v.id === version.id} onClick={() => select({ version: v.version_number })}>
                      <span className="pc-chip__v">{`v${String(v.version_number)}`}</span>
                      <span className={`pc-chip__pill pc-tone--${VERSION_PILL[v.status].tone}`}>{VERSION_PILL[v.status].label}</span>
                      <span className="pc-chip__n">{chipPinned(v)}</span>
                    </Button>
                  ))}
                </div>
                <div className="pc-editor" data-testid="version-editor">
                  <div className="pc-editor__head">
                    <b className="pc-editor__title">{editor.title}</b>
                    <span className={`pc-editor__pill pc-tone--${editor.pill.tone}`}>
                      <span className="pc-editor__dot" aria-hidden="true" />
                      {editor.pill.label}
                    </span>
                    <span className="pc-editor__meta">{editor.meta}</span>
                  </div>
                  {editor.lockText !== null ? <div className="pc-lock">{`🔒 ${editor.lockText}`}</div> : null}
                  <div className="pc-fields">
                    {editor.fields.map((f) => (
                      <label key={f.key} className="pc-field" title={f.title}>
                        <span className="pc-field__label">{f.label}</span>
                        <Input
  unstyled
                          type="number"
                          min={0}
                          className={`pc-input${f.editable ? ' pc-input--editable' : ''}`}
                          value={f.value}
                          placeholder={f.placeholder}
                          disabled={f.readOnly}
                          readOnly={f.readOnly}
                          aria-invalid={invalid === f.key || undefined}
                          onChange={(e) => setInputs((m) => ({ ...m, [f.key]: e.target.value }))}
                          onBlur={() => {
                            if (f.key !== 'seats') void saveField(f.key);
                          }}
                        />
                      </label>
                    ))}
                    {editor.locks.map((l) => (
                      <label key={l.label} className="pc-field" title={V1_LOCK_TITLE}>
                        <span className="pc-field__label pc-field__label--lock">
                          {l.label}
                          <span className="pc-field__lock">🔒 v1 limit</span>
                        </span>
                        <Input unstyled className="pc-input pc-input--lock" value={l.value} disabled title={V1_LOCK_TITLE} readOnly />
                      </label>
                    ))}
                  </div>
                  {version.status === 'DRAFT' && lastPublished(plan, version) ? (
                    <>
                      <div className="pc-caps pc-caps--16">{`Compared with published v${String(lastPublished(plan, version)?.version_number ?? '')}`}</div>
                      <div className="pc-diff" role="table" aria-label="Draft compared with the published version">
                        {draftDiff((lastPublished(plan, version) as CatalogVersion).terms, version.terms, 'editor').map((d) => (
                          <div key={d.field} role="row" className={`pc-diff__row${d.changed ? ' pc-diff__row--changed' : ''}`}>
                            <span role="cell" className="pc-diff__mark">
                              {d.changed ? '~' : ''}
                            </span>
                            <span role="cell" className="pc-diff__field">
                              {d.field}
                            </span>
                            <span role="cell" className="pc-diff__before">
                              {d.before}
                            </span>
                            <span role="cell" className="pc-diff__after">
                              {d.after}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                  <div className="pc-caps pc-caps--14">Tenants pinned to this version</div>
                  <div className="pc-pinned">{pinnedLine(version, tenantNames[version.id] ?? null)}</div>
                  {(() => {
                    const open = openRequestOf(version);
                    if (open === null) return null;
                    const s = openRequestSentence(open);
                    const apply = applyActionable[open.id] === true ? applyActionOf(open) : null;
                    return (
                      <>
                        <div className="pc-open" data-testid="open-request">
                          {`${s.lead} `}
                          <a href={`/commercial/approvals?request=${encodeURIComponent(open.id)}`}>{shortId(open.id)}</a>
                          {` is ${s.state}.`}
                        </div>
                        {apply !== null ? (
                          <div className="pc-actions">
                            <Button unstyled type="button" className="pc-btn" disabled={busy} onClick={() => void applyRequest(open.id)}>
                              {apply.label}
                            </Button>
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                  {saveError !== null || actionError !== null ? (
                    <div className="pc-alert" role="alert">
                      {saveError ?? actionError}
                    </div>
                  ) : null}
                  <div className="pc-actions">
                    {versionActions(plan, version, canDraft).map((a) => (
                      <Button unstyled
                        key={a.kind}
                        type="button"
                        className={`pc-btn${a.tone === 'terra' ? ' pc-btn--terra' : ''}`}
                        disabled={a.disabled || busy}
                        title={a.why}
                        onClick={() => {
                          if (a.kind === 'draft') void createDraft(version);
                          else void openDialog(a.kind);
                        }}
                      >
                        {a.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          )}
        </>
      )}

      {dialog !== null ? (
        <CommercialRequestDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          title={`${dialog.kind === 'publish' ? 'Request publish · ' : 'Request retire · '}${versionTitle(dialog.plan, dialog.version)}`}
          sub={
            dialog.kind === 'publish'
              ? `Once published, v${String(dialog.version.version_number)} can’t be edited. Existing subscriptions stay on their pinned version; new subscriptions use v${String(dialog.version.version_number)}.`
              : `Retired versions take no new subscriptions. ${String(dialog.version.pinned_subscriptions)} tenant(s) stay pinned to it (grandfathered).`
          }
          diff={dialogDiff}
          chain={chainNode}
          typed={dialog.kind === 'retire' ? { token: `${dialog.plan.name} v${String(dialog.version.version_number)}`, value: typed, onChange: setTyped } : null}
          alert={dialogError}
          commitLabel="Submit for approval"
          tone={dialog.kind === 'retire' ? 'danger' : 'terra'}
          canCommit={reason.trim().length > 0 && evidence.trim().length > 0}
          busy={busy}
          onCommit={() => void submitRequest()}
        >
          <RequestField label="Reason" value={reason} onChange={setReason} placeholder="Why this change is needed" multiline />
          <RequestField label="Evidence" value={evidence} onChange={setEvidence} placeholder="Document, ticket or call notes reference" />
        </CommercialRequestDialog>
      ) : null}
    </div>
  );
}
