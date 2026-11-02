import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  TemplateStudio,
  organizationStudioCopy,
  organizationStudioDataSource,
  templateProductsLine,
  type TemplateDefaultPreview,
  type TemplateStudioCopy,
  type TemplateStudioDataSource,
} from '@aramo/document-templates-web';

import { errorMessage } from '../api';
import { SIGN_STUDIO_API, signTemplateGalleryApi, type SignGalleryItem, type SignStudioList } from '../template-studio-api';
import { Btn, Empty, ErrorBox, Loading, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.1–8.2 (R6) and §8.5 (R6-M) —
// Templates for a PERSONAL account inside Aramo Sign (a Business account keeps the existing list
// and manages templates in Org Home):
//   - My templates: the account's own templates (adopted Aramo templates; drafts and approved).
//   - Aramo templates: the Aramo defaults tagged Sign, with Preview, "Adopt and edit" (opens the
//     shared Studio on the new draft) and "Use as it is" (one call: adopt + approve unchanged).
//   - The shared Template Studio (libs/document-templates-web, organization context) on a Sign
//     data source: edit / preview / "Use this version" (the Personal word for Approve).
//     Letterhead = the person's name (the server answers it).
// Free plan (Catalog v2 P-6): an upgrade prompt, no templates. Every authority is server-side:
// these screens only reflect the sender context (template_plan / template_studio /
// template_use_as_is) and show the server's refusals.

export const ASK_ADMIN = 'Ask an admin to approve this template.';

/** The Personal Studio copy: "Use this version" for Approve; the person's own templates. */
export function personalStudioCopy(listHref: string): TemplateStudioCopy {
  const base = organizationStudioCopy({ organizationHref: null, listHref });
  const approveDialog: TemplateStudioCopy['approveDialog'] = {
    title: (next) => `Use version v${next}?`,
    commit: (next) => `Use this version (v${next})`,
    from: (current) => (current !== null ? { label: `v${current} in use`, tone: 'ok' } : { label: 'No version in use', tone: 'neutral' }),
    to: (next) => ({ label: `v${next} in use`, tone: 'ok' }),
    consequence: (next) => `v${next} becomes the version you send from now on. Documents already sent stay on the version they were sent with.`,
  };
  return {
    ...base,
    crumbs: [{ label: 'Templates', to: listHref }],
    back: { to: listHref, label: 'Back to Templates' },
    approveButton: (next, wide) => (wide ? `Use this version (v${next})…` : `Use v${next}…`),
    approveHint: 'Use this version requires every check to pass',
    readinessLabel: (r, wide) => (r.ready ? (wide ? 'Ready to use' : 'Ready') : `${r.fails}${r.fails === 1 ? ' issue' : ' issues'}${wide ? ' before use' : ''}`),
    checksNote: 'Use this version unlocks when every required check passes. Saving the draft again resets the preview check.',
    approveDialog,
    approveToast: (n) => `v${n} is in use. New documents use it from now on.`,
    approveFailed: 'This version couldn’t be put to use.',
    versionActive: { label: 'In use', tone: 'ok' },
    scopeCard: 'Your template · used for every document of this type you send from Aramo Sign.',
    approveWarnings: (n) => `${n} warning${n > 1 ? 's' : ''} (inactive variables) will be used as is.`,
    restoreToast: (n) => `Draft replaced with v${n}. Save and preview before using it.`,
    // One wording for every document type (no organization / RTR copy).
    forDocumentType: () => ({ approveDialog }),
  };
}

/** §8.3 — the Sign data source: the shared organization source over the Sign calls. */
export function personalStudioDataSource(input: { listHref: string; canEdit: boolean }): TemplateStudioDataSource {
  const org = organizationStudioDataSource({ session: null, organizationHref: null, listHref: input.listHref, api: SIGN_STUDIO_API });
  return {
    ...org,
    // The Sections set is the organization's recruiting clauses: none for a personal account.
    sections: undefined,
    // The `sign` session carries document_template:read only; the Personal owner's author +
    // approve come from the sender context (template_studio) and are re-checked server-side.
    capabilities: { ...org.capabilities, canEdit: input.canEdit, canApprove: input.canEdit },
    copy: personalStudioCopy(input.listHref),
  };
}

type Access = 'unavailable' | 'upgrade' | 'no-permission' | 'ok';

export function personalTemplateAccess(ctx: ReturnType<typeof useWorkspace>['ctx']): Access {
  if (ctx.features?.templates !== true) return 'unavailable';
  if (ctx.template_plan != null && ctx.template_plan !== 'INCLUDED') return 'upgrade';
  if (ctx.permissions.templates !== true || ctx.template_studio !== true) return 'no-permission';
  return 'ok';
}

function Page({ children, tag }: { children: ReactNode; tag?: ReactNode }) {
  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Templates</h1>
        {tag ?? null}
      </div>
      {children}
    </div>
  );
}

function AccessState({ access }: { access: Exclude<Access, 'ok'> }) {
  const { base, ctx } = useWorkspace();
  const state = (title: string, body: ReactNode, tag: string, testId: string) => (
    <Page tag={<span className="sg-tag sg-tag--grey">{tag}</span>}>
      <section className="sg-card" data-testid={testId}>
        <div className="sg-empty" style={{ padding: '48px 20px' }}>
          <div className="sg-empty__t">{title}</div>
          {body}
        </div>
      </section>
    </Page>
  );
  if (access === 'unavailable') {
    return state(
      'Templates are coming soon',
      'Starting documents from templates is coming soon. It isn’t part of any plan yet. Until then, create each envelope from your PDF.',
      'Coming soon',
      'templates-unavailable',
    );
  }
  if (access === 'upgrade') {
    return state(
      'Templates come with Personal Standard',
      <>
        <div>
          {ctx.template_plan === 'FREE_PLAN'
            ? 'Templates aren’t included in the Free plan. Upgrade to Personal Standard to adopt Aramo templates, edit them and send from them.'
            : 'Templates need an active Aramo Sign plan.'}
        </div>
        <div style={{ marginTop: 14 }}>
          <Link className="sg-btn sg-btn--primary" to={`${base}/settings/billing`} data-testid="templates-upgrade">
            See plans
          </Link>
        </div>
      </>,
      'Upgrade',
      'templates-upgrade-prompt',
    );
  }
  return state('You don’t have access to templates', 'Templates for this account aren’t available to you.', 'Not available', 'templates-no-permission');
}

export function PersonalTemplatesPage() {
  const { ctx } = useWorkspace();
  const access = personalTemplateAccess(ctx);
  if (access !== 'ok') return <AccessState access={access} />;
  return (
    <Routes>
      <Route index element={<PersonalTemplateList />} />
      <Route path="studio/:id" element={<PersonalStudio />} />
      <Route path="*" element={<PersonalTemplateList />} />
    </Routes>
  );
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: 'In use', DRAFT: 'Draft', RETIRED: 'Retired' };

function PersonalTemplateList() {
  const { base, ctx, toast } = useWorkspace();
  const nav = useNavigate();
  const [list, setList] = useState<SignStudioList | null>(null);
  const [gallery, setGallery] = useState<SignGalleryItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const load = useCallback(() => {
    setError('');
    Promise.all([signTemplateGalleryApi.studioList(), signTemplateGalleryApi.gallery()])
      .then(([l, g]) => {
        setList(l);
        setGallery(g.items);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const mine = useMemo(() => (list?.items ?? []).filter((i) => i.owner_scope === 'TENANT'), [list]);
  const studioHref = (id: string) => `${base}/templates/studio/${id}`;

  const adopt = async (item: SignGalleryItem) => {
    setBusy(item.template_id);
    setError('');
    try {
      const out = await signTemplateGalleryApi.adopt(item.template_id);
      nav(studioHref(out.template.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const applyAsIs = async (item: SignGalleryItem) => {
    setBusy(item.template_id);
    setError('');
    try {
      await signTemplateGalleryApi.adoptAndUse(item.template_id);
      toast(`“${item.name}” is in My templates and ready to use.`);
      load();
    } catch (e) {
      setError(asIsRefusalMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <p className="sg-muted" style={{ marginTop: 0 }}>
        Adopt an Aramo template, edit it if you need to, and choose “Use this version”. Your letterhead is your name.
      </p>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {list === null && error === '' ? <Loading /> : null}
      {list !== null ? (
        <section className="sg-card" data-testid="my-templates">
          <div className="sg-card__head">My templates</div>
          {mine.length === 0 ? (
            <Empty title="No templates yet">Adopt an Aramo template below to make it yours.</Empty>
          ) : (
            mine.map((t) => (
              <div key={t.id} className="sg-row" data-testid={`my-template-${t.id}`}>
                <span className="sg-docicon" aria-hidden="true" />
                <div className="sg-row__main">
                  <div className="sg-row__t">{t.name}</div>
                  <div className="sg-row__s">
                    {STATUS_LABEL[t.status] ?? t.status}
                    {t.current_version_number !== null ? ` · v${t.current_version_number}` : ''} · Updated {fmtDate(t.updated_at)}
                  </div>
                </div>
                <Link className="sg-btn sg-btn--sm" to={studioHref(t.id)} data-testid={`open-studio-${t.id}`}>
                  {t.status === 'ACTIVE' ? 'Open' : 'Edit'}
                </Link>
                {t.status === 'ACTIVE' && ctx.can_send ? (
                  <Link className="sg-btn sg-btn--sm sg-btn--primary" to={`${base}/templates/${t.id}/use`} data-testid={`use-template-${t.id}`}>
                    Use template
                  </Link>
                ) : null}
              </div>
            ))
          )}
        </section>
      ) : null}
      {gallery !== null ? (
        <section className="sg-card" style={{ marginTop: 16 }} data-testid="aramo-templates">
          <div className="sg-card__head">Aramo templates</div>
          {gallery.length === 0 ? <Empty title="No Aramo templates yet">Aramo templates for Aramo Sign appear here when they are published.</Empty> : null}
          {gallery.map((g) => (
            <div key={g.template_id} data-testid={`gallery-${g.template_id}`}>
              <div className="sg-row">
                <span className="sg-docicon" aria-hidden="true" />
                <div className="sg-row__main">
                  <div className="sg-row__t">{g.name}</div>
                  <div className="sg-row__s">
                    {g.document_type.name ?? 'Document'} · {templateProductsLine(g.products)} · Updated {fmtDate(g.updated_at)}
                  </div>
                  {g.description !== null && g.description.trim() !== '' ? <div className="sg-row__s sg-faint">{g.description}</div> : null}
                </div>
                <Btn size="sm" onClick={() => setPreviewing(previewing === g.template_id ? null : g.template_id)} aria-expanded={previewing === g.template_id}>
                  {previewing === g.template_id ? 'Hide preview' : 'Preview'}
                </Btn>
                {g.adopted_template_id !== null ? (
                  <Link className="sg-btn sg-btn--sm" to={studioHref(g.adopted_template_id)} data-testid={`in-mine-${g.template_id}`}>
                    In My templates
                  </Link>
                ) : (
                  <>
                    <Btn size="sm" disabled={busy !== null} onClick={() => void adopt(g)} data-testid={`adopt-${g.template_id}`}>
                      Adopt and edit
                    </Btn>
                    {ctx.template_use_as_is === true ? (
                      <Btn size="sm" variant="primary" disabled={busy !== null} onClick={() => void applyAsIs(g)} data-testid={`use-as-is-${g.template_id}`}>
                        {busy === g.template_id ? 'Adding…' : 'Use as it is'}
                      </Btn>
                    ) : null}
                  </>
                )}
              </div>
              {previewing === g.template_id ? <GalleryPreview id={g.template_id} name={g.name} /> : null}
            </div>
          ))}
        </section>
      ) : null}
    </Page>
  );
}

/** §8.5 — the refusal of "Use as it is" as the person reads it. */
export function asIsRefusalMessage(e: unknown): string {
  const details = (e as { details?: Record<string, unknown> } | null)?.details;
  if (details?.['reason'] === 'template_approval_required') return ASK_ADMIN;
  if (details?.['reason'] === 'already_adopted') return 'This template is already in My templates.';
  return errorMessage(e);
}

function GalleryPreview({ id, name }: { id: string; name: string }) {
  const [preview, setPreview] = useState<TemplateDefaultPreview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    signTemplateGalleryApi
      .previewDefault(id)
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [id]);
  if (error !== '') return <ErrorBox>{error}</ErrorBox>;
  if (preview === null) return <Loading label="Preparing preview…" />;
  return (
    <div className="sg-card__body" data-testid="gallery-preview">
      {preview.letterhead.organization_name !== null ? <div className="sg-muted">{preview.letterhead.organization_name}</div> : null}
      <h2 style={{ margin: '6px 0' }}>{preview.title}</h2>
      {preview.html !== undefined ? (
        <iframe title={`Preview of ${name}`} sandbox="" srcDoc={preview.html} style={{ width: '100%', minHeight: 320, border: '1px solid var(--line)' }} />
      ) : (
        (preview.blocks ?? []).map((b, i) => (
          <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {b.text}
          </p>
        ))
      )}
    </div>
  );
}

function PersonalStudio() {
  const { id = '' } = useParams();
  const { base, ctx } = useWorkspace();
  const listHref = `${base}/templates`;
  const dataSource = useMemo(() => personalStudioDataSource({ listHref, canEdit: ctx.template_studio === true }), [listHref, ctx.template_studio]);
  return (
    <div className="sg-studio" data-testid="personal-template-studio" style={{ height: 'calc(100vh - 56px)', minWidth: 0, overflow: 'hidden' }}>
      <TemplateStudio key={id} context="organization" dataSource={dataSource} templateId={id} formatError={(e, fallback) => (e instanceof Error && e.message !== '' ? errorMessage(e) : fallback)} />
    </div>
  );
}
