import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { errorMessage, senderApi, type SenderTemplate, type TemplatePreview } from '../api';
import { Btn, Empty, ErrorBox, Field, Loading, TextIn, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7.3–7.4 (ADR-0034 D6,
// D7, D11, D12). Templates are Documents-owned and managed in Org Home; Aramo Sign keeps
// only the "use" side: list the organization's templates (its active choice per document
// type — client → organization → Aramo default), preview them with the organization's
// branding, and start an envelope from one. Variables the organization profile does not
// supply become fields the sender fills in. Every authority stays server-side (plan
// capability, document_template:read, sign:envelope:create); this page only reflects it.
//
// When the plan capability `sign.templates` is not available, the page shows the same
// "Not available" treatment the console uses for other unavailable capabilities.

export function TemplatesPage() {
  return (
    <Routes>
      <Route index element={<TemplateList />} />
      <Route path=":id/use" element={<UseTemplate />} />
      <Route path="*" element={<TemplateList />} />
    </Routes>
  );
}

// The Org Home template administration (where templates are created and approved).
function orgTemplatesUrl(appHomeUrl: string | null): string | null {
  return appHomeUrl === null ? null : `${appHomeUrl.replace(/\/+$/, '')}/org/document-templates`;
}

function Unavailable({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Templates</h1>
        <span className="sg-tag sg-tag--grey" data-testid="templates-unavailable-tag">
          Not available
        </span>
      </div>
      <section className="sg-card" data-testid="templates-unavailable">
        <div className="sg-empty" style={{ padding: '48px 20px' }}>
          <div className="sg-empty__t">{title}</div>
          {children}
        </div>
      </section>
    </div>
  );
}

// The plan / permission state every template screen shares.
function useTemplateAccess(): 'unavailable' | 'no-permission' | 'ok' {
  const { ctx } = useWorkspace();
  if (ctx.features?.templates !== true) return 'unavailable';
  if (ctx.permissions.templates !== true) return 'no-permission';
  return 'ok';
}

function AccessGate({ access }: { access: 'unavailable' | 'no-permission' }) {
  return access === 'unavailable' ? (
    <Unavailable title="Templates aren’t available on your plan yet">
      Starting envelopes from your organization’s document templates isn’t part of your Aramo Sign plan yet. Until then, create each envelope from your PDF.
    </Unavailable>
  ) : (
    <Unavailable title="You don’t have access to templates">Ask your organization admin for access to document templates.</Unavailable>
  );
}

function TemplateList() {
  const { base, ctx } = useWorkspace();
  const access = useTemplateAccess();
  const [items, setItems] = useState<SenderTemplate[] | null>(null);
  const [unavailableTypes, setUnavailableTypes] = useState<number>(0);
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(() => {
    if (access !== 'ok') return;
    senderApi
      .templates()
      .then((r) => {
        setItems(r.items);
        setUnavailableTypes(r.unavailable.length);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [access]);

  if (access !== 'ok') return <AccessGate access={access} />;
  const manageUrl = orgTemplatesUrl(ctx.app_home_url);

  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Templates</h1>
        <div className="sg-pagehead__end">
          {manageUrl !== null ? (
            <a className="sg-btn" href={manageUrl} data-testid="manage-templates-link">
              Manage templates in Org Home
            </a>
          ) : null}
        </div>
      </div>
      <p className="sg-muted" style={{ marginTop: 0 }}>
        Your organization’s document templates. Each document type uses your organization’s active choice — its own template or the Aramo default — with your
        organization’s branding.
      </p>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {items === null && error === '' ? <Loading /> : null}
      {items !== null && items.length === 0 ? (
        <section className="sg-card">
          <Empty title="No templates yet">
            {unavailableTypes > 0
              ? 'Your organization needs to choose a template for its document types. An admin can do this in Org Home.'
              : 'Your organization has no document templates to start an envelope from yet.'}
          </Empty>
        </section>
      ) : null}
      {items !== null && items.length > 0 ? (
        <section className="sg-card">
          {items.map((t) => (
            <div key={t.template_id} data-testid={`template-${t.template_id}`}>
              <div className="sg-row">
                <span className="sg-docicon" aria-hidden="true" />
                <div className="sg-row__main">
                  <div className="sg-row__t">{t.name}</div>
                  <div className="sg-row__s">
                    {t.document_type.name} · {t.owner_scope === 'PLATFORM' ? 'Aramo default' : 'Your organization'} · v{t.version_number} · Updated{' '}
                    {fmtDate(t.updated_at)}
                  </div>
                </div>
                <Btn size="sm" onClick={() => setPreviewing(previewing === t.template_id ? null : t.template_id)} aria-expanded={previewing === t.template_id}>
                  {previewing === t.template_id ? 'Hide preview' : 'Preview'}
                </Btn>
                {ctx.can_send ? (
                  <Link className="sg-btn sg-btn--sm sg-btn--primary" to={`${base}/templates/${t.template_id}/use`} data-testid={`use-template-${t.template_id}`}>
                    Use template
                  </Link>
                ) : null}
              </div>
              {previewing === t.template_id ? <PreviewPanel template={t} values={{}} /> : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

// The template rendered with the organization's branding and the sender's values so far.
// html content is the server's allowlisted html, shown in a fully sandboxed frame.
function PreviewPanel({ template, values }: { template: SenderTemplate; values: Record<string, string> }) {
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(values);
  useEffect(() => {
    let live = true;
    senderApi
      .previewTemplate(template.template_id, JSON.parse(key) as Record<string, string>)
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [template.template_id, key]);
  if (error !== '') return <ErrorBox>{error}</ErrorBox>;
  if (preview === null) return <Loading label="Preparing preview…" />;
  return (
    <div className="sg-card__body" data-testid="template-preview">
      {preview.letterhead.organization_name !== null ? <div className="sg-muted">{preview.letterhead.organization_name}</div> : null}
      <h2 style={{ margin: '6px 0' }}>
        {preview.title}
      </h2>
      {preview.html !== null ? (
        <iframe title={`Preview of ${template.name}`} sandbox="" srcDoc={preview.html} style={{ width: '100%', minHeight: 320, border: '1px solid var(--line)' }} />
      ) : (
        preview.blocks.map((b, i) =>
          b.type === 'HEADING' ? (
            <h3 key={i}>
              {b.text}
            </h3>
          ) : (
            <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {b.text}
            </p>
          ),
        )
      )}
    </div>
  );
}

function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// "Use template" — the sender fills the variables the organization profile does not
// supply (and optionally names the first signer, who gets the template's signature area);
// Documents renders the frozen document and the envelope wizard opens on it.
function UseTemplate() {
  const { id = '' } = useParams();
  const { base, ctx, refreshCounts } = useWorkspace();
  const nav = useNavigate();
  const access = useTemplateAccess();
  const [template, setTemplate] = useState<SenderTemplate | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [subject, setSubject] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // One key per attempt on this page: a retried click never renders a second document.
  const idempotencyKey = useRef(newKey());

  useEffect(() => {
    if (access !== 'ok') return;
    senderApi
      .templates()
      .then((r) => setTemplate(r.items.find((t) => t.template_id === id) ?? null))
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setTemplate(null);
      });
  }, [access, id]);

  const senderVars = useMemo(() => (template ?? null)?.variables.filter((v) => v.source === 'SENDER') ?? [], [template]);
  const orgVars = useMemo(() => (template ?? null)?.variables.filter((v) => v.source === 'ORGANIZATION') ?? [], [template]);

  if (access !== 'ok') return <AccessGate access={access} />;
  if (!ctx.can_send) return <Unavailable title="You can’t create envelopes">Ask your organization admin for sending access.</Unavailable>;
  if (template === undefined) return <Loading />;
  if (template === null)
    return (
      <div className="sg-page">
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : <ErrorBox>This template isn’t available to your organization.</ErrorBox>}
        <Link className="sg-back" to={`${base}/templates`}>
          Back to templates
        </Link>
      </div>
    );

  const missing = senderVars.filter((v) => (values[v.key] ?? '').trim() === '').map((v) => v.label);
  const signerPartial = (signerName.trim() === '') !== (signerEmail.trim() === '');

  const create = async () => {
    setError('');
    setBusy(true);
    try {
      const filled: Record<string, string> = {};
      for (const v of senderVars) filled[v.key] = (values[v.key] ?? '').trim();
      const out = await senderApi.fromTemplate({
        template_id: template.template_id,
        values: filled,
        idempotency_key: idempotencyKey.current,
        ...(subject.trim() !== '' ? { subject: subject.trim() } : {}),
        ...(signerName.trim() !== '' && signerEmail.trim() !== '' ? { signer: { name: signerName.trim(), email: signerEmail.trim() } } : {}),
      });
      refreshCounts();
      nav(`${base}/envelopes/${out.envelope.id}/edit?step=2`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sg-page sg-page--wide">
      <Link className="sg-back" to={`${base}/templates`}>
        Templates
      </Link>
      <h1 className="sg-h1">Use “{template.name}”</h1>
      <p className="sg-muted">
        {template.document_type.name} · {template.owner_scope === 'PLATFORM' ? 'Aramo default' : 'Your organization'} · v{template.version_number}. The document is
        created from this exact version with your organization’s branding; you add signers and fields next.
      </p>
      <div className="sg-grid sg-grid--main">
        <section className="sg-card">
          <div className="sg-card__head">Fill in the template</div>
          <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
            {senderVars.length === 0 ? <div className="sg-muted">This template needs no details from you.</div> : null}
            {senderVars.map((v) => (
              <Field key={v.key} label={v.label} htmlFor={`tv-${v.key}`} help={v.group !== '' ? v.group : undefined}>
                <TextIn
                  id={`tv-${v.key}`}
                  data-testid={`template-var-${v.key}`}
                  value={values[v.key] ?? ''}
                  maxLength={2000}
                  onChange={(e) => setValues((cur) => ({ ...cur, [v.key]: e.target.value }))}
                />
              </Field>
            ))}
            <Field label="Email subject (optional)" htmlFor="tpl-subject">
              <TextIn id="tpl-subject" value={subject} maxLength={200} placeholder={template.name} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <div className="sg-grid sg-grid--2">
              <Field label="First signer’s name (optional)" htmlFor="tpl-signer-name">
                <TextIn id="tpl-signer-name" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
              </Field>
              <Field label="First signer’s email (optional)" htmlFor="tpl-signer-email">
                <TextIn id="tpl-signer-email" type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} />
              </Field>
            </div>
            <div className="sg-help">The first signer gets the template’s signature area. You can add more signers and fields in the next steps.</div>
          </div>
        </section>
        <section className="sg-card">
          <div className="sg-card__head">From your organization</div>
          {orgVars.length === 0 ? <div className="sg-empty">Nothing from your organization profile is used.</div> : null}
          {orgVars.map((v) => (
            <div key={v.key} className="sg-row">
              <div className="sg-row__main">
                <div className="sg-row__t">{v.label}</div>
                <div className="sg-row__s">{v.value}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
      <div style={{ marginTop: 12 }}>
        <Btn onClick={() => setShowPreview((s) => !s)} aria-expanded={showPreview}>
          {showPreview ? 'Hide preview' : 'Preview with these details'}
        </Btn>
        {showPreview ? (
          <section className="sg-card" style={{ marginTop: 10 }}>
            <PreviewPanel template={template} values={Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''))} />
          </section>
        ) : null}
      </div>
      {error !== '' ? (
        <div style={{ marginTop: 10 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      <div className="sg-wizfoot">
        <Btn onClick={() => nav(`${base}/templates`)}>Cancel</Btn>
        <Btn
          variant="primary"
          data-testid="create-from-template"
          disabled={busy || missing.length > 0 || signerPartial}
          title={missing.length > 0 ? `Fill in: ${missing.join(', ')}` : signerPartial ? 'Give the signer’s name and email, or neither' : undefined}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create envelope'}
        </Btn>
      </div>
    </div>
  );
}
