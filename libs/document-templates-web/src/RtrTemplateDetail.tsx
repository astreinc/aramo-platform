import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, safeErrorMessage, useSession, useToast, type Session } from '@aramo/fe-foundation';

import {
  createDraftFromActive,
  deleteDraftVersion,
  fetchTemplateCatalog,
  listAllowedBindings,
  listDocumentTemplates,
  listTemplateVersions,
  previewTemplateVersion,
  resolveUserNames,
  canAuthorTemplates,
  canReadTemplates,
  RIGHT_TO_REPRESENT_TYPE_ID,
  versionLogoUrl,
  type DocumentTemplateView,
  type TemplateCatalog,
  type TemplateVersionView,
} from './document-templates-api';
import {
  bindingMapFrom,
  emptyBindingMap,
  fmtDate,
  parseContent,
  signatureFrom,
  CheckIcon,
  DocIconSmall,
  LockIcon,
  Segments,
  SignatureBlock,
  TALENT_NAME_KEY,
  type BindingMap,
} from './dt-ui';
import { contentFromVersion, htmlOf, previewContentFrom, DiscardModal, PreviewModal, type PreviewContent } from './dt-modals';
import { SafeDoc, type LetterheadInfo } from './dt-html-render';
import { useDocTemplateRoutes } from './dt-routes';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§7) — the Right-to-Represent detail, styled to the approved
// prototype: breadcrumb, header card with the 4-fact meta grid + actions, and a
// two-column grid (Versions · Where it's used + Approved content). Status vocabulary is
// Draft / Active / Retired — never "Approved" as a status. Historical versions are
// pinned; approved versions are read-only (edits go to a new draft).


type LoadState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      template: DocumentTemplateView;
      versions: readonly TemplateVersionView[];
      map: BindingMap;
      names: Record<string, string>;
      tenantName: string;
    };

function pillClass(status: string): string {
  if (status === 'ACTIVE') return 'dt-pill--active';
  if (status === 'DRAFT') return 'dt-pill--draft';
  return 'dt-pill--retired';
}
function pillLabel(status: string): string {
  return status === 'ACTIVE' ? 'Active' : status === 'DRAFT' ? 'Draft' : 'Retired';
}

export function RtrTemplateDetail({
  templateId,
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  listBindingsFn,
  catalogFn,
  resolveNamesFn = resolveUserNames,
  createDraftFn = createDraftFromActive,
  previewFn = previewTemplateVersion,
  discardFn = deleteDraftVersion,
}: {
  // DOC-TEMPLATE-LIB-1 T-4 — the tenant template to show (Org Home routes by id). Absent:
  // the tenant's Right to Represent template (the original single-type behaviour).
  readonly templateId?: string;
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly listBindingsFn?: typeof listAllowedBindings;
  readonly catalogFn?: (templateId: string) => Promise<TemplateCatalog>;
  readonly resolveNamesFn?: typeof resolveUserNames;
  readonly createDraftFn?: typeof createDraftFromActive;
  readonly previewFn?: typeof previewTemplateVersion;
  readonly discardFn?: typeof deleteDraftVersion;
} = {}) {
  const routes = useDocTemplateRoutes();
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  // ORG-UX-1 §4.1 — new draft / draft preview / discard are authoring (author-or-manage).
  const canRead = canReadTemplates(session);
  const canAuthor = canAuthorTemplates(session);
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const justActivated = params.get('activated') != null;

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [allVers, setAllVers] = useState(false);
  const [preview, setPreview] = useState<PreviewContent | null>(null);
  const [discardTarget, setDiscardTarget] = useState<TemplateVersionView | null>(null);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => (templateId != null ? t.id === templateId : t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID)) ?? null;
      if (rtr == null) { setLoad({ status: 'empty' }); return; }
      const loadCatalog = catalogFn ?? (listBindingsFn != null
        ? (id: string) => listBindingsFn(id).then((b): TemplateCatalog => ({ bindings: b, tenantLogo: null }))
        : fetchTemplateCatalog);
      const [versions, catalog] = await Promise.all([listVersionsFn(rtr.id), loadCatalog(rtr.id)]);
      const bindings = catalog.bindings;
      const ids = [...new Set(versions.flatMap((v) => [v.activated_by, v.created_by]).filter((x): x is string => x != null))];
      let names: Record<string, string> = {};
      try { names = await resolveNamesFn(ids); } catch { names = {}; }
      setLoad({ status: 'ready', template: rtr, versions, map: bindingMapFrom(bindings), names, tenantName: catalog.tenantLogo?.tenant_name ?? '' });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load the RTR template.') });
    }
  }, [templateId, listTemplatesFn, listVersionsFn, listBindingsFn, catalogFn, resolveNamesFn]);

  useEffect(() => { if (canRead) void refetch(); }, [canRead, refetch]);

  if (!canRead) {
    return (
      <div className="dt-root">
        <div className="set-content">
          <div className="dt-noaccess">
            <div className="dt-noaccess__t">Document templates are managed by your Tenant Admins</div>
            <div className="dt-noaccess__b">
              When you send a Right to Represent, Aramo uses the version your organization approved. You
              don’t need to pick or edit a template.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const crumb = (
    <div className="dt-crumb">
      <a onClick={() => navigate(routes.list)} data-testid="rtr-detail-back">Document templates</a>
      <span>/</span>
      <span className="dt-crumb__cur">Right to Represent</span>
    </div>
  );

  async function startDraft(template: DocumentTemplateView, draft: TemplateVersionView | undefined) {
    if (draft != null) { navigate(routes.draft(template.id)); return; }
    setBusy(true);
    try {
      await createDraftFn(template.id);
      navigate(routes.draft(template.id));
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not start a new draft.'));
      setBusy(false);
    }
  }

  // Discard the open DRAFT (author-or-manage; the row action is never offered on ACTIVE/RETIRED,
  // and the backend refuses a non-DRAFT regardless).
  async function discardDraft(v: TemplateVersionView) {
    setBusy(true);
    try {
      await discardFn(v.id);
      setDiscardTarget(null);
      toast.show(`Draft v${v.version_number} discarded. The active version is unchanged.`);
      await refetch();
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not discard this draft.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dt-root">
      <div className="set-content" data-testid="rtr-detail-page">
        {load.status === 'loading' ? <div className="dt-wrap">{crumb}<p className="dt-note" style={{ marginTop: 16 }}>Loading…</p></div> : null}
        {load.status === 'error' ? <div className="dt-wrap">{crumb}<p className="dt-note" style={{ marginTop: 16, color: '#B3402A' }}>{load.message}</p></div> : null}
        {load.status === 'empty' ? (
          <div className="dt-wrap dt-col">
            {crumb}
            <div className="dt-card dt-pad">
              <div className="dt-cardtitle">No Right to Represent template yet</div>
              <div className="dt-note">A workspace admin creates the first version from the draft editor. Until an approved version exists, recruiters cannot send an RTR.</div>
            </div>
          </div>
        ) : null}
  
        {load.status === 'ready'
          ? (() => {
              const { template, versions, map, names, tenantName } = load;
              const letterheadOf = (v: TemplateVersionView): LetterheadInfo => ({ src: v.logo != null ? versionLogoUrl(v.id, v.logo.asset_id) : null, tenantName });
              const nameOf = (id: string | null): string => (id != null ? names[id] ?? '' : '');
              const draft = versions.find((v) => v.status === 'DRAFT');
              const active = versions.find((v) => v.id === template.current_version_id) ?? versions.find((v) => v.status === 'ACTIVE');
              const nonDraft = versions.filter((v) => v.status !== 'DRAFT').sort((a, b) => b.version_number - a.version_number);
              const verAll = (draft != null ? [draft] : []).concat(nonDraft);
              const shown = allVers || verAll.length <= 4 ? verAll : verAll.slice(0, 3);
              const hasMore = verAll.length > 4;
              const activeContent = active != null ? parseContent(active.field_schema, map) : { title: '', blocks: [] };
              const activeHtml = active != null ? htmlOf(active.field_schema) : null;
              const activeLabel = active != null ? `v${active.version_number}` : '—';
              const topRetired = nonDraft.find((v) => v.status === 'RETIRED');
  
              const whenOf = (v: TemplateVersionView): string => {
                if (v.status === 'DRAFT') return `Draft · based on v${active?.version_number ?? '—'}`;
                if (v.activated_at != null) {
                  const by = nameOf(v.activated_by);
                  return `Approved ${fmtDate(v.activated_at)}${by !== '' ? ` · ${by}` : ''}`;
                }
                return `Initial system version · ${fmtDate(v.created_at)}`;
              };
              const openPreview = async (v: TemplateVersionView) => {
                const label = `${v.status === 'DRAFT' ? 'Draft ' : ''}v${v.version_number} · ${template.name}${v.status !== 'DRAFT' ? ` · ${pillLabel(v.status)}` : ''}`;
                if (v.status === 'DRAFT' && canAuthor) {
                  // A DRAFT previews through the SERVER's fixed-sample render (§17; author scope).
                  try {
                    const res = await previewFn(v.id);
                    setPreview(previewContentFrom(res, label, { src: versionLogoUrl(v.id, v.logo?.asset_id ?? null), tenantName }));
                  } catch (err) {
                    toast.show(safeErrorMessage(err, 'Preview failed. Check that every field is a supported one.'));
                  }
                  return;
                }
                // ACTIVE/RETIRED (or a reader without author): the server sample preview is
                // DRAFT-only + author-scoped, so show the stored wording with field chips — no
                // values invented on the client.
                setPreview(contentFromVersion(v, map, label, letterheadOf(v)));
              };
  
              return (
                <div className="dt-wrap dt-col">
                  {crumb}
                  {justActivated && active != null ? (
                    <div className="dt-banner" data-testid="rtr-activated-banner">
                      <CheckIcon stroke="currentColor" />
                      <span>
                        <b>{activeLabel} is now active.</b> Every new RTR uses it from now on.{' '}
                        {topRetired != null ? `v${topRetired.version_number} is retired. ` : ''}
                        RTRs that were already sent keep the version they were created from.
                      </span>
                    </div>
                  ) : null}
  
                  <div className="dt-card dt-headcard">
                    <div className="dt-headcard__main">
                      <div className="dt-titlerow">
                        <h1>Right to Represent</h1>
                        {active != null ? (
                          <span className="dt-pill dt-pill--active"><span className="dt-pill__dot" />Active</span>
                        ) : (
                          <span className="dt-pill dt-pill--muted"><span className="dt-pill__dot" />No approved version</span>
                        )}
                      </div>
                      <div className="dt-subname">{template.name}</div>
                      <div className="dt-meta">
                        <div><div className="dt-meta__l">Scope</div><div className="dt-meta__v">Tenant default</div></div>
                        <div><div className="dt-meta__l">Current approved version</div><div className="dt-meta__v">{activeLabel}</div></div>
                        <div><div className="dt-meta__l">Approved</div><div className="dt-meta__v">{active != null ? fmtDate(active.activated_at) : '—'}</div></div>
                        <div><div className="dt-meta__l">Approved by</div><div className="dt-meta__v">{active != null && nameOf(active.activated_by) !== '' ? nameOf(active.activated_by) : '—'}</div></div>
                      </div>
                    </div>
                    <div className="dt-headcard__actions">
                      {active != null ? (
                        <Button unstyled className="dt-btn dt-btn--neutral dt-btn--lg" onClick={() => void openPreview(active)} data-testid="rtr-preview-active">
                          Preview approved version
                        </Button>
                      ) : null}
                      {canAuthor ? (
                        <Button unstyled className="dt-btn dt-btn--primary dt-btn--lg" onClick={() => void startDraft(template, draft)} disabled={busy} data-testid="rtr-detail-draft">
                          {draft != null ? `Continue draft v${draft.version_number}` : 'Create new version'}
                        </Button>
                      ) : null}
                    </div>
                  </div>
  
                  <div className="dt-two">
                    <div className="dt-card dt-card--clip" data-testid="rtr-version-history">
                      <div className="dt-verhead">
                        <span className="dt-verhead__t">Versions</span>
                        <span className="dt-verhead__h">Approved versions can't be edited. Changes go into a new draft.</span>
                      </div>
                      {shown.map((v) => (
                        <div key={v.id} className={`dt-verrow${v.status === 'DRAFT' ? ' dt-verrow--draft' : ''}`} data-testid={`rtr-version-${v.version_number}`}>
                          <span className={`dt-ver__n${v.status === 'RETIRED' ? ' dt-ver__n--retired' : ''}`}>v{v.version_number}</span>
                          <span>
                            <span className={`dt-pill ${pillClass(v.status)}`} style={{ fontSize: '10.5px', padding: '2px 9px' }}>
                              <span className="dt-pill__dot" />{pillLabel(v.status)}
                            </span>
                          </span>
                          <span className="dt-ver__when">{whenOf(v)}</span>
                          <span className="dt-ver__acts">
                            {v.status === 'DRAFT' ? (
                              <Button unstyled className="dt-link" onClick={() => navigate(routes.draft(template.id))}>Continue editing</Button>
                            ) : (
                              <Button unstyled className="dt-link" onClick={() => void openPreview(v)}>View</Button>
                            )}
                            <Button unstyled className="dt-link" onClick={() => void openPreview(v)}>Preview</Button>
                            {v.status === 'DRAFT' && canAuthor ? (
                              <Button unstyled className="dt-link dt-link--danger" onClick={() => setDiscardTarget(v)} disabled={busy} data-testid="rtr-detail-discard">Discard</Button>
                            ) : null}
                          </span>
                        </div>
                      ))}
                      {hasMore ? (
                        <Button unstyled className="dt-vermore" onClick={() => setAllVers((s) => !s)}>
                          {allVers ? 'Show fewer' : `Show all ${verAll.length} versions`}
                        </Button>
                      ) : null}
                    </div>
  
                    <div className="dt-two__right">
                      <div className="dt-card dt-pad">
                        <div className="dt-cardtitle">Where it's used</div>
                        <div className="dt-used__body">
                          Requisition → Talent → <b>Send RTR</b>. Recruiters see which version is being sent but can't choose or edit it:
                        </div>
                        <div className="dt-provbox">
                          <DocIconSmall />
                          <span style={{ minWidth: 0 }}>
                            <span className="dt-prov__name">{template.name} · {activeLabel} · <span className="dt-prov__by" style={{ display: 'inline' }}>Approved by your organization</span></span>
                          </span>
                          <LockIcon style={{ marginLeft: 'auto' }} />
                        </div>
                        <div className="dt-note">Scope: tenant default. Client-specific document templates may be supported later.</div>
                      </div>
                      {active != null ? (
                        <div className="dt-card dt-pad">
                          <div className="dt-contenthead">
                            <span className="dt-cardtitle" style={{ marginBottom: 0 }}>Approved content</span>
                            <span className="dt-verhead__h">{activeLabel} · read-only</span>
                          </div>
                          <div className="dt-doctitle">{activeContent.title}</div>
                          {activeHtml != null ? (
                            <SafeDoc html={activeHtml} map={map} mode="content" letterhead={active.logo != null ? letterheadOf(active) : null} testId="rtr-approved-doc" />
                          ) : null}
                          {activeHtml != null ? null : activeContent.blocks.filter((b) => b.text.trim() !== '').map((b, i) =>
                            b.type === 'HEADING' ? (
                              <div className="dt-pvpaper__h" key={i}><Segments text={b.text} map={map} /></div>
                            ) : (
                              <p className="dt-para" key={i}><Segments text={b.text} map={map} /></p>
                            ),
                          )}
                          {signatureFrom(active) != null ? (
                            <SignatureBlock mode="template" nameLabel={map.labelByToken[TALENT_NAME_KEY] ?? 'Talent full name'} className="dt-sig--paper" testId="rtr-approved-signature" />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })()
          : null}
      </div>

      {preview != null ? (
        <PreviewModal
          content={preview}
          map={load.status === 'ready' ? load.map : emptyBindingMap()}
          onClose={() => { setPreview(null); if (justActivated) { params.delete('activated'); setParams(params, { replace: true }); } }}
        />
      ) : null}
      {discardTarget != null ? (
        <DiscardModal
          draftVersion={discardTarget.version_number}
          busy={busy}
          onCancel={() => setDiscardTarget(null)}
          onDiscard={() => void discardDraft(discardTarget)}
        />
      ) : null}
    </div>
  );
}
