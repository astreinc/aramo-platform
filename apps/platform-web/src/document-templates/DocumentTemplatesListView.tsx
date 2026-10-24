import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, hasScope, type Session } from '@aramo/fe-foundation';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { FieldSelect, FieldText, FieldTextArea } from '../components/ConfirmFields';
import { EmptyState } from '../components/EmptyState';
import { SegmentedFilter } from '../components/FilterBar';
import { Pill, type PillSpec } from '../components/Pill';
import { Skeleton } from '../components/Skeleton';
import { TagInput } from '../components/TagInput';
import { ViewOnlyNote } from '../components/ViewOnlyNote';
import { formatDate, formatDateRelative } from '../components/format-date';

import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  HTML_CONTENT_VERSION,
  documentTemplatesApi,
  withdrawalStateOf,
  type DocumentTypeOption,
  type PlatformTemplate,
} from './document-templates-api';
import { templateErrorMessage } from './template-errors';
import './studio/studio.css';

// PLATFORM-UX-1 F-9 (handoff §10.1; directive R-10, R-12) — the template library at
// /document-templates: page header + "Create default template" (:manage), the product
// segmented filter and search, and the table (Template · Current version · Draft ·
// Products · Updated · "Open studio →"). A row opens the Studio at /document-templates/:id.

type ProductFilter = 'ALL' | 'ATS' | 'SIGN';

const NAME_MAX = 120;
const DESC_MAX = 500;

function currentPill(t: PlatformTemplate): PillSpec {
  return t.current_version !== null ? { label: `Published v${t.current_version.version_number}`, tone: 'ok' } : { label: 'Not published', tone: 'neutral' };
}

function withdrawalPill(t: PlatformTemplate): PillSpec | null {
  const s = withdrawalStateOf(t);
  if (s === 'PENDING') return { label: `Withdrawal ${formatDate(t.withdraw_effective_at)}`, tone: 'warn' };
  if (s === 'IN_EFFECT') return { label: 'Withdrawn', tone: 'muted' };
  return null;
}

export function DocumentTemplatesListView({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const [templates, setTemplates] = useState<PlatformTemplate[] | null>(null);
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<ProductFilter>('ALL');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [res, dt] = await Promise.all([
        documentTemplatesApi.listTemplates(),
        documentTemplatesApi.listDocumentTypes().catch(() => ({ document_types: [] as DocumentTypeOption[] })),
      ]);
      setTemplates(res.templates);
      setTypes(dt.document_types);
    } catch (e) {
      setTemplates([]);
      setError(templateErrorMessage(e, 'Failed to load document templates.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const typeName = useCallback((id: string) => types.find((t) => t.id === id)?.name ?? id, [types]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (templates ?? []).filter(
      (t) => (product === 'ALL' || t.products.includes(product)) && (s === '' || t.name.toLowerCase().includes(s) || typeName(t.document_type_id).toLowerCase().includes(s)),
    );
  }, [templates, product, q, typeName]);

  return (
    <div className="pws-lib">
      <div className="pws-lib__head">
        <div>
          <h1 className="pws-lib__h1">Document templates</h1>
          <p className="pws-lib__intro">Platform defaults that tenants start from. Open one to edit its draft in the Template Studio.</p>
        </div>
        {canManage ? (
          <Button unstyled className="pw-btn pw-btn--normal" onClick={() => setCreating(true)}>
            + Create default template
          </Button>
        ) : null}
      </div>
      {!canManage ? (
        <div className="pws-lib__note">
          <ViewOnlyNote permission="Manage templates" subject="these templates" needs="Changing them needs" />
        </div>
      ) : null}
      <div className="pws-lib__filters">
        <SegmentedFilter<ProductFilter>
          label="Product"
          value={product}
          onChange={setProduct}
          options={[
            { value: 'ALL', label: 'All products' },
            { value: 'ATS', label: 'ATS' },
            { value: 'SIGN', label: 'SIGN' },
          ]}
        />
        <Input unstyled className="pws-in pws-in--38 pws-lib__q" value={q} placeholder="Search templates" aria-label="Search templates" onChange={(e) => setQ(e.target.value)} />
        <span className="pws-lib__count" role="status">
          {templates === null ? '' : `${rows.length} templates`}
        </span>
      </div>
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error pws-lib__err">
          {error}
        </div>
      ) : null}
      <div className="pws-lib__card">
        <div className="pws-lib__scroll">
          <table className="pws-lib__table">
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Current version</th>
                <th scope="col">Draft</th>
                <th scope="col">Products</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="pw-sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {templates === null
                ? [0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      <td>
                        <Skeleton width={180} />
                      </td>
                      <td>
                        <Skeleton width={110} height={22} radius={11} />
                      </td>
                      <td>
                        <Skeleton width={80} />
                      </td>
                      <td>
                        <Skeleton width={70} />
                      </td>
                      <td>
                        <Skeleton width={130} />
                      </td>
                      <td />
                    </tr>
                  ))
                : rows.map((t) => {
                    const wd = withdrawalPill(t);
                    const cur = currentPill(t);
                    return (
                      <tr key={t.id} className="pws-lib__row" onClick={() => navigate(`/document-templates/${t.id}`)}>
                        <td>
                          <b className="pws-lib__name">{t.name}</b>
                          <div className="pws-lib__sub">
                            {typeName(t.document_type_id)} · <span className="pws-mono">{t.id}</span>
                          </div>
                        </td>
                        <td>
                          <Pill tone={cur.tone}>{cur.label}</Pill>
                          {wd !== null ? (
                            <div className="pws-lib__wd">
                              <span className="pws-pill20">
                                <Pill tone={wd.tone} dot={false}>
                                  {wd.label}
                                </Pill>
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td className={`pws-lib__draft${t.draft_version_id !== null ? ' pws-lib__draft--open' : ''}`}>{t.draft_version_id !== null ? 'Open draft' : 'No draft'}</td>
                        <td>
                          <span className="pws-tags">
                            {t.products.map((p) => (
                              <span key={p} className="pws-tag">
                                {p}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="pws-lib__upd">{formatDateRelative(t.updated_at)}</td>
                        <td className="pws-lib__open">
                          <Link to={`/document-templates/${t.id}`} className="pws-lib__openlink" onClick={(e) => e.stopPropagation()} aria-label={`Open studio for ${t.name}`}>
                            Open studio →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {templates !== null && rows.length === 0 ? (
          templates.length === 0 ? (
            <EmptyState size="lg" title="No default templates yet" body={canManage ? 'Create one to give tenants a starting point.' : 'Templates appear here once they are created.'} />
          ) : (
            <EmptyState size="lg" title="No templates match" body="Try another product or search term." />
          )
        ) : null}
      </div>

      {creating ? (
        <CreateTemplateDialog
          open={creating}
          onOpenChange={setCreating}
          templates={templates ?? []}
          types={types}
          onCreated={(id, copyError) => {
            setCreating(false);
            navigate(`/document-templates/${id}`, copyError !== null ? { state: { copyError } } : undefined);
          }}
        />
      ) : null}
    </div>
  );
}

export interface CreateTemplateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly templates: readonly PlatformTemplate[];
  readonly types: readonly DocumentTypeOption[];
  /** The new template id; copyError when the copy's draft step failed after creation (R-10). */
  readonly onCreated: (id: string, copyError: string | null) => void;
}

/**
 * "Create default template" (handoff §10.1; directive R-10). Start from: a blank document,
 * or a copy of a PUBLISHED template of the SAME document type — its current version is read
 * first (GET …/versions/:versionId), then the template is created, then its first draft
 * with the copied field_schema. If that draft step fails, the operator still lands in the
 * Studio (on the empty draft) with the error shown inline.
 */
export function CreateTemplateDialog({ open, onOpenChange, templates, types, onCreated }: CreateTemplateDialogProps) {
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState<string[]>(['ATS']);
  const [start, setStart] = useState('blank');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources = templates.filter((t) => t.document_type_id === typeId && t.current_version !== null);
  const sourceKey = sources.map((t) => t.id).join(',');
  // A copy source must stay of the chosen document type (R-10): changing the type resets it.
  useEffect(() => {
    if (start !== 'blank' && !sourceKey.split(',').includes(start.slice(5))) setStart('blank');
  }, [start, sourceKey]);

  const ok = typeId !== '' && name.trim() !== '' && types.find((t) => t.id === typeId)?.configurable === true;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const src = start.startsWith('copy:') ? templates.find((t) => t.id === start.slice(5)) : undefined;
    let copied: { render_schema_version: string; field_schema: unknown } | null = null;
    try {
      if (src?.current_version) {
        const v = await documentTemplatesApi.getVersion(src.current_version.id);
        copied = { render_schema_version: v.render_schema_version || HTML_CONTENT_VERSION, field_schema: v.field_schema };
      }
    } catch (e) {
      setError(templateErrorMessage(e, 'Could not read the published version to copy.'));
      setBusy(false);
      return;
    }
    let created: PlatformTemplate;
    try {
      created = await documentTemplatesApi.createTemplate({
        document_type_id: typeId,
        name: name.trim(),
        description: desc.trim() !== '' ? desc.trim() : null,
        template_kind: 'GENERATED',
        products: tags,
      });
    } catch (e) {
      setError(templateErrorMessage(e, 'Create failed.'));
      setBusy(false);
      return;
    }
    let copyError: string | null = null;
    if (copied !== null) {
      try {
        await documentTemplatesApi.createDraft(created.id, copied);
      } catch (e) {
        copyError = `The template was created, but copying ${src?.name ?? 'the published version'} into its draft failed: ${templateErrorMessage(e, 'the draft could not be created.')}`;
      }
    }
    setBusy(false);
    onCreated(created.id, copyError);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create default template"
      consequence="Creates a platform default with a draft. Tenants only see it after you publish."
      commitLabel="Create and open studio"
      canCommit={ok}
      busy={busy}
      error={error}
      onCommit={() => void submit()}
    >
      <FieldSelect
        label="Document type"
        required
        value={typeId}
        onChange={setTypeId}
        helper="Fixed by regulation or a provider? Those types are listed but can’t be chosen."
        options={[
          { value: '', label: 'Choose a document type' },
          ...types.map((t) => ({ value: t.id, label: t.configurable ? t.name : `${t.name} — not configurable here`, disabled: !t.configurable })),
        ]}
      />
      <div className="pws-countfield">
        <FieldText label="Name" required value={name} onChange={(v) => setName(v.slice(0, NAME_MAX))} maxLength={NAME_MAX} />
        <span className="pw-field__count" aria-live="polite">
          {name.length} / {NAME_MAX}
        </span>
      </div>
      <FieldTextArea label="Description (optional)" value={desc} onChange={setDesc} max={DESC_MAX} />
      <div className="pws-countfield">
        <TagInput label="Product tags" tags={tags} onChange={setTags} />
        <span className="pw-field__helper">Enter to add. Uppercase, up to 16.</span>
      </div>
      <FieldSelect
        label="Start from"
        value={start}
        onChange={setStart}
        helper="Copying fills the new draft with that published version."
        options={[
          { value: 'blank', label: 'Blank document' },
          ...sources.map((t) => ({ value: `copy:${t.id}`, label: `Copy of ${t.name} (v${t.current_version?.version_number ?? ''})` })),
        ]}
      />
    </ConfirmDialog>
  );
}
