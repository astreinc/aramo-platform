import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  DataTable,
  FormField,
  InlineAlert,
  Input,
  Select,
  StatusPill,
  TagList,
  TextArea,
  formatDate,
  hasScope,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  DEFAULT_WITHDRAW_NOTICE_DAYS,
  DOC_TEMPLATE_MANAGE_SCOPE,
  HTML_CONTENT_VERSION,
  MAX_WITHDRAW_NOTICE_DAYS,
  documentTemplatesApi,
  htmlContentOf,
  parseProductTags,
  withdrawalStateOf,
  type AllowedBinding,
  type PlatformTemplateDetail,
  type SamplePreview,
  type TemplateVersion,
} from './document-templates-api';
import { SafeTemplateHtml } from './SafeTemplateHtml';
import { templateErrorMessage } from './template-errors';

// DOC-TEMPLATE-LIB-1 T-2 (§8.1) — one Aramo default: metadata + product tags, the
// version history, the current published content, and the DRAFT editor (author →
// preview → publish). The editor is deliberately minimal (title + allowlisted html +
// "Insert variable" from the catalog-driven allowed bindings); the ATS rich editor lives
// in apps/ats-web and cannot be imported across apps — T-4 extracts the shared
// libs/document-templates-web editor. The server is authoritative for sanitisation,
// the catalog check and the preview-before-publish gate.

const VERSION_COLUMNS: ReadonlyArray<TableColumn<TemplateVersion>> = [
  { key: 'n', header: 'Version', render: (v) => `v${v.version_number}` },
  { key: 's', header: 'Status', render: (v) => (v.status === 'ACTIVE' ? 'Published' : v.status === 'RETIRED' ? 'Replaced' : 'Draft') },
  { key: 'a', header: 'Published', render: (v) => (v.activated_at !== null ? formatDate(v.activated_at) : '—') },
];

export function DocumentTemplateDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams<{ id: string }>();
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const [detail, setDetail] = useState<PlatformTemplateDetail | null>(null);
  const [bindings, setBindings] = useState<AllowedBinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, b] = await Promise.all([documentTemplatesApi.getTemplate(id), documentTemplatesApi.allowedBindings(id)]);
      setDetail(d);
      setBindings(b.bindings);
    } catch (e) {
      setError(templateErrorMessage(e, 'Failed to load the template.'));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const labels = useMemo(() => Object.fromEntries(bindings.map((b) => [b.key, b.label])), [bindings]);
  const current = detail?.versions.find((v) => v.id === detail.current_version?.id) ?? null;
  const draft = detail?.versions.find((v) => v.status === 'DRAFT') ?? null;
  const currentHtml = current !== null ? htmlContentOf(current) : null;

  const run = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(templateErrorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const startDraft = (): Promise<void> =>
    run(async () => {
      if (detail === null) return;
      // With a published version the draft starts from it (server-side copy); a brand
      // new default starts from an empty allowlisted document.
      await (detail.current_version !== null
        ? documentTemplatesApi.createDraft(id)
        : documentTemplatesApi.createDraft(id, {
            render_schema_version: HTML_CONTENT_VERSION,
            field_schema: { render_schema_version: HTML_CONTENT_VERSION, title: detail.name, html: '<p></p>' },
          }));
      await load();
    }, 'Could not start a draft.');

  if (detail === null) {
    return (
      <div className="pw-page">
        {error ? <InlineAlert variant="error">{error}</InlineAlert> : <p>Loading…</p>}
      </div>
    );
  }

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">{detail.name}</h1>
        {canManage && draft === null ? (
          <Button variant="primary" onClick={() => void startDraft()} disabled={busy}>
            {detail.current_version !== null ? 'Start new version' : 'Start first version'}
          </Button>
        ) : null}
      </div>
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {notice ? <InlineAlert variant="success">{notice}</InlineAlert> : null}

      <section className="pw-panel" aria-label="Template details">
        <p>
          Aramo default · {detail.current_version !== null ? `current version v${detail.current_version.version_number}` : 'not published yet'}
          {' · '}Updated {formatDate(detail.current_version?.activated_at ?? detail.updated_at)}
        </p>
        {detail.description !== null ? <p>{detail.description}</p> : null}
        <ProductTagsEditor
          products={detail.products}
          canManage={canManage}
          onSave={(products) =>
            run(async () => {
              await documentTemplatesApi.updateTemplate(id, { products });
              await load();
              setNotice('Product tags saved.');
            }, 'Could not save the product tags.')
          }
        />
      </section>

      <WithdrawalPanel
        template={detail}
        canManage={canManage}
        busy={busy}
        onWithdraw={(notice_days, reason) =>
          run(async () => {
            const t = await documentTemplatesApi.withdraw(id, { notice_days, reason });
            await load();
            setNotice(
              t.withdraw_effective_at !== null
                ? `Withdrawal published. It takes effect on ${formatDate(t.withdraw_effective_at)}.`
                : 'Withdrawal published.',
            );
          }, 'Could not publish the withdrawal.')
        }
        onCancel={() =>
          run(async () => {
            await documentTemplatesApi.cancelWithdrawal(id);
            await load();
            setNotice('Withdrawal cancelled.');
          }, 'Could not cancel the withdrawal.')
        }
      />

      {draft !== null ? (
        <DraftEditor
          key={draft.id}
          draft={draft}
          bindings={bindings}
          labels={labels}
          canManage={canManage}
          onChanged={load}
          onNotice={setNotice}
        />
      ) : null}

      <section className="pw-panel" aria-label="Current published version">
        <h2 className="pw-panel__title">Current published version</h2>
        {current === null ? (
          <p>Not published yet. Organizations fall back to their own template until a version is published.</p>
        ) : currentHtml !== null ? (
          <>
            <h3>{currentHtml.title}</h3>
            <SafeTemplateHtml html={currentHtml.html} labels={labels} testId="pw-dt-current" />
          </>
        ) : (
          <p>This version uses an earlier content format; start a new version to edit it here.</p>
        )}
      </section>

      <section className="pw-panel" aria-label="Versions">
        <h2 className="pw-panel__title">Versions</h2>
        <DataTable columns={VERSION_COLUMNS} rows={detail.versions} rowKey={(v) => v.id} emptyMessage="No versions yet." />
      </section>
    </div>
  );
}

// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — withdrawal status + actions. Publishing a
// withdrawal gives organizations a notice (default 7 days); from the effective date the
// default is no longer used and organizations fall back to their own approved template,
// or are asked to choose. A pending withdrawal can be cancelled before it takes effect.
export function WithdrawalPanel({
  template,
  canManage,
  busy,
  onWithdraw,
  onCancel,
}: {
  readonly template: Pick<PlatformTemplateDetail, 'status' | 'current_version' | 'withdraw_notice_at' | 'withdraw_effective_at'>;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onWithdraw: (noticeDays: number, reason: string | null) => Promise<void>;
  readonly onCancel: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(String(DEFAULT_WITHDRAW_NOTICE_DAYS));
  const [reason, setReason] = useState('');
  const state = withdrawalStateOf(template);
  const published = template.status === 'ACTIVE' && template.current_version !== null;
  const parsedDays = Number(days);
  const daysValid = days.trim() !== '' && Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= MAX_WITHDRAW_NOTICE_DAYS;

  return (
    <section className="pw-panel" aria-label="Withdrawal">
      <h2 className="pw-panel__title">Withdrawal</h2>
      {state === 'NONE' ? (
        <p>{published ? 'Not withdrawn. Organizations use this default.' : 'Not published yet, so it cannot be withdrawn.'}</p>
      ) : state === 'PENDING' ? (
        <p>
          <StatusPill tone="warn">Withdrawal pending</StatusPill>{' '}
          Published{template.withdraw_notice_at !== null ? ` on ${formatDate(template.withdraw_notice_at)}` : ''}. It takes effect on{' '}
          {formatDate(template.withdraw_effective_at)}. Until then organizations still use this default and see a notice.
        </p>
      ) : (
        <p>
          <StatusPill tone="neutral">Withdrawn</StatusPill>{' '}
          Since {formatDate(template.withdraw_effective_at)}. Organizations now use their own approved template, or are asked to choose one.
        </p>
      )}
      {canManage && state === 'NONE' && published && !open ? (
        <div className="pw-toolbar">
          <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy}>
            Withdraw…
          </Button>
        </div>
      ) : null}
      {canManage && state === 'NONE' && published && open ? (
        <div>
          <FormField label={`Notice period in days (0–${MAX_WITHDRAW_NOTICE_DAYS})`}>
            <Input
              unstyled
              aria-label="Notice days"
              className="tc-input"
              type="number"
              min={0}
              max={MAX_WITHDRAW_NOTICE_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </FormField>
          <FormField label="Reason (optional, recorded in the audit log)">
            <TextArea unstyled aria-label="Reason" className="tc-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="pw-toolbar">
            <Button
              variant="primary"
              disabled={busy || !daysValid}
              onClick={() => {
                void onWithdraw(parsedDays, reason.trim() === '' ? null : reason.trim()).then(() => setOpen(false));
              }}
            >
              Publish withdrawal
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
          {!daysValid ? <p className="pw-panel__sub">Enter a whole number of days between 0 and {MAX_WITHDRAW_NOTICE_DAYS}.</p> : null}
        </div>
      ) : null}
      {canManage && state === 'PENDING' ? (
        <div className="pw-toolbar">
          <Button variant="secondary" onClick={() => void onCancel()} disabled={busy}>
            Cancel withdrawal
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ProductTagsEditor({
  products,
  canManage,
  onSave,
}: {
  readonly products: readonly string[];
  readonly canManage: boolean;
  readonly onSave: (products: string[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(products.join(', '));
  if (!editing) {
    return (
      <div className="pw-toolbar">
        <span>Products:</span>
        {products.length > 0 ? <TagList tags={products} max={8} /> : <span>none</span>}
        {canManage ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit products
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="pw-toolbar">
      <Input unstyled aria-label="Products" className="tc-input" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          void onSave(parseProductTags(value)).then(() => setEditing(false));
        }}
      >
        Save products
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}

export function DraftEditor({
  draft,
  bindings,
  labels,
  canManage,
  onChanged,
  onNotice,
}: {
  readonly draft: TemplateVersion;
  readonly bindings: readonly AllowedBinding[];
  readonly labels: Readonly<Record<string, string>>;
  readonly canManage: boolean;
  readonly onChanged: () => Promise<void>;
  readonly onNotice: (msg: string | null) => void;
}) {
  const content = htmlContentOf(draft);
  const [title, setTitle] = useState(content?.title ?? '');
  const [html, setHtml] = useState(content?.html ?? '');
  const [insertKey, setInsertKey] = useState(bindings[0]?.key ?? '');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<SamplePreview | null>(null);
  const [previewed, setPreviewed] = useState(
    draft.previewed_fingerprint !== null && draft.previewed_fingerprint === draft.content_fingerprint,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  if (content === null) {
    return (
      <section className="pw-panel" aria-label="Draft">
        <h2 className="pw-panel__title">Draft v{draft.version_number}</h2>
        <p>This draft uses a content format the platform editor does not support.</p>
      </section>
    );
  }

  const insertVariable = (): void => {
    if (insertKey === '') return;
    const token = `<span data-field="${insertKey}"></span>`;
    const el = area.current;
    const at = el !== null ? el.selectionStart : html.length;
    setHtml(html.slice(0, at) + token + html.slice(at));
    setDirty(true);
    setPreviewed(false);
  };

  const save = async (): Promise<void> => {
    await documentTemplatesApi.updateDraft(draft.id, {
      render_schema_version: HTML_CONTENT_VERSION,
      field_schema: { render_schema_version: HTML_CONTENT_VERSION, title: title.trim(), html },
    });
    setDirty(false);
    setPreviewed(false);
  };

  const act = async (fn: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(templateErrorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pw-panel" aria-label="Draft">
      <h2 className="pw-panel__title">Draft v{draft.version_number}</h2>
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Document title">
        <Input
          unstyled
          aria-label="Document title"
          className="tc-input"
          value={title}
          readOnly={!canManage}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
            setPreviewed(false);
          }}
        />
      </FormField>
      <FormField label="Content (allowed: p, h2, b, i, u, ul, ol, li, br and variables)">
        <TextArea
          unstyled
          ref={area}
          aria-label="Content"
          className="tc-input pw-dt-source"
          rows={12}
          value={html}
          readOnly={!canManage}
          onChange={(e) => {
            setHtml(e.target.value);
            setDirty(true);
            setPreviewed(false);
          }}
        />
      </FormField>
      {canManage ? (
        <div className="pw-toolbar">
          <Select unstyled aria-label="Variable" className="tc-input" value={insertKey} onChange={(e) => setInsertKey(e.target.value)}>
            {bindings.map((b) => (
              <option key={b.key} value={b.key}>
                {b.group} · {b.label}
              </option>
            ))}
          </Select>
          <Button variant="secondary" size="sm" onClick={insertVariable} disabled={insertKey === ''}>
            Insert variable
          </Button>
          <Button variant="secondary" onClick={() => void act(async () => { await save(); await onChanged(); }, 'Could not save the draft.')} disabled={busy || !dirty}>
            Save draft
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void act(async () => {
                if (dirty) await save();
                setPreview(await documentTemplatesApi.preview(draft.id));
                setPreviewed(true);
              }, 'Preview failed.')
            }
            disabled={busy}
          >
            Preview
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              void act(async () => {
                await documentTemplatesApi.publish(draft.id);
                onNotice(`Version v${draft.version_number} is now the current published version.`);
                await onChanged();
              }, 'Publish failed.')
            }
            disabled={busy || dirty || !previewed}
          >
            Publish
          </Button>
        </div>
      ) : null}
      {canManage && !previewed ? <p className="pw-panel__sub">Preview the current draft before publishing it.</p> : null}
      {preview !== null ? (
        <div aria-label="Preview">
          <h3>{preview.title}</h3>
          <SafeTemplateHtml html={preview.html ?? ''} labels={labels} testId="pw-dt-preview" />
        </div>
      ) : (
        <SafeTemplateHtml html={html} labels={labels} testId="pw-dt-draft" />
      )}
    </section>
  );
}
