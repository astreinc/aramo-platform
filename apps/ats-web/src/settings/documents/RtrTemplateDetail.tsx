import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, hasScope, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { resolveUserNames } from '../../users/users-api';

import {
  createDraftFromActive,
  listAllowedBindings,
  listDocumentTemplates,
  listTemplateVersions,
  DOC_TEMPLATE_MANAGE_SCOPE,
  DOC_TEMPLATE_READ_SCOPE,
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateVersionView,
} from './document-templates-api';
import {
  bindingMapFrom,
  emptyBindingMap,
  fmtDate,
  parseContent,
  CheckIcon,
  DocIconSmall,
  LockIcon,
  Segments,
  type BindingMap,
} from './dt-ui';
import { PreviewModal, type PreviewContent } from './dt-modals';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§7) — the Right-to-Represent detail, styled to the approved
// prototype: breadcrumb, header card with the 4-fact meta grid + actions, and a
// two-column grid (Versions · Where it's used + Approved content). Status vocabulary is
// Draft / Active / Retired — never "Approved" as a status. Historical versions are
// pinned; approved versions are read-only (edits go to a new draft).

const DRAFT_ROUTE = '/admin/settings/document-templates/rtr/draft';
const LIST_ROUTE = '/admin/settings/document-templates';

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
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  listBindingsFn = listAllowedBindings,
  resolveNamesFn = resolveUserNames,
  createDraftFn = createDraftFromActive,
}: {
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly listBindingsFn?: typeof listAllowedBindings;
  readonly resolveNamesFn?: typeof resolveUserNames;
  readonly createDraftFn?: typeof createDraftFromActive;
} = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, DOC_TEMPLATE_READ_SCOPE);
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const justActivated = params.get('activated') != null;

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [allVers, setAllVers] = useState(false);
  const [preview, setPreview] = useState<PreviewContent | null>(null);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID) ?? null;
      if (rtr == null) { setLoad({ status: 'empty' }); return; }
      const [versions, bindings] = await Promise.all([listVersionsFn(rtr.id), listBindingsFn(rtr.id)]);
      const ids = [...new Set(versions.flatMap((v) => [v.activated_by, v.created_by]).filter((x): x is string => x != null))];
      let names: Record<string, string> = {};
      try { names = await resolveNamesFn(ids); } catch { names = {}; }
      setLoad({ status: 'ready', template: rtr, versions, map: bindingMapFrom(bindings), names });
    } catch (err) {
      setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load the RTR template.' });
    }
  }, [listTemplatesFn, listVersionsFn, listBindingsFn, resolveNamesFn]);

  useEffect(() => { if (canRead) void refetch(); }, [canRead, refetch]);

  if (!canRead) {
    return (
      <div className="dt-root">
        <div className="dt-noaccess">
          <div className="dt-noaccess__t">Document templates are managed by your Tenant Admins</div>
          <div className="dt-noaccess__b">
            When you send a Right to Represent, Aramo uses the version your organization approved. You
            don’t need to pick or edit a template.
          </div>
        </div>
      </div>
    );
  }

  const crumb = (
    <div className="dt-crumb">
      <a onClick={() => navigate(LIST_ROUTE)} data-testid="rtr-detail-back">Document templates</a>
      <span>/</span>
      <span className="dt-crumb__cur">Right to Represent</span>
    </div>
  );

  async function startDraft(template: DocumentTemplateView, draft: TemplateVersionView | undefined) {
    if (draft != null) { navigate(DRAFT_ROUTE); return; }
    setBusy(true);
    try {
      await createDraftFn(template.id);
      navigate(DRAFT_ROUTE);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not start a new draft.');
      setBusy(false);
    }
  }

  return (
    <div className="dt-root">
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
            const { template, versions, map, names } = load;
            const nameOf = (id: string | null): string => (id != null ? names[id] ?? '' : '');
            const draft = versions.find((v) => v.status === 'DRAFT');
            const active = versions.find((v) => v.id === template.current_version_id) ?? versions.find((v) => v.status === 'ACTIVE');
            const nonDraft = versions.filter((v) => v.status !== 'DRAFT').sort((a, b) => b.version_number - a.version_number);
            const verAll = (draft != null ? [draft] : []).concat(nonDraft);
            const shown = allVers || verAll.length <= 4 ? verAll : verAll.slice(0, 3);
            const hasMore = verAll.length > 4;
            const activeContent = active != null ? parseContent(active.field_schema, map) : { title: '', paras: [] as string[] };
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
            const openPreview = (v: TemplateVersionView) => {
              const c = parseContent(v.field_schema, map);
              setPreview({ label: `${v.status === 'DRAFT' ? 'Draft ' : ''}v${v.version_number} · ${template.name}${v.status !== 'DRAFT' ? ` · ${pillLabel(v.status)}` : ''}`, title: c.title, paras: c.paras });
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
                      <Button unstyled className="dt-btn dt-btn--neutral dt-btn--lg" onClick={() => openPreview(active)} data-testid="rtr-preview-active">
                        Preview approved version
                      </Button>
                    ) : null}
                    {canManage ? (
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
                            <Button unstyled className="dt-link" onClick={() => navigate(DRAFT_ROUTE)}>Continue editing</Button>
                          ) : (
                            <Button unstyled className="dt-link" onClick={() => openPreview(v)}>View</Button>
                          )}
                          <Button unstyled className="dt-link" onClick={() => openPreview(v)}>Preview</Button>
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
                          <span className="dt-prov__name">{template.name} · {activeLabel}</span>
                          <span className="dt-prov__by">Approved by your organization</span>
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
                        {activeContent.paras.filter((p) => p.trim() !== '').map((p, i) => (
                          <p className="dt-para" key={i}><Segments text={p} map={map} /></p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })()
        : null}

      {preview != null ? (
        <PreviewModal
          content={preview}
          map={load.status === 'ready' ? load.map : emptyBindingMap()}
          onClose={() => { setPreview(null); if (justActivated) { params.delete('activated'); setParams(params, { replace: true }); } }}
        />
      ) : null}
    </div>
  );
}
