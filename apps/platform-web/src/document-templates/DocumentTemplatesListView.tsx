import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  Button,
  DataTable,
  Dialog,
  FormField,
  InlineAlert,
  Input,
  Select,
  TagList,
  TextArea,
  formatDate,
  hasScope,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  documentTemplatesApi,
  parseProductTags,
  type DocumentTypeOption,
  type PlatformTemplate,
} from './document-templates-api';
import { templateErrorMessage } from './template-errors';

// DOC-TEMPLATE-LIB-1 T-2 (§8.1; ADR-0034 D2/D3/D9) — the Aramo default templates list.
// Each default shows its current published version, an "Updated" date (the current
// version's publish date, else the last change) and its product tags. Create is
// manage-gated; authoring lives on the detail page.

function updatedOf(t: PlatformTemplate): string {
  return formatDate(t.current_version?.activated_at ?? t.updated_at);
}

const COLUMNS: ReadonlyArray<TableColumn<PlatformTemplate>> = [
  {
    key: 'name',
    header: 'Name',
    render: (t) => (
      <Link className="rc-link-strong" to={`/document-templates/${t.id}`}>
        <span className="rc-ent__nm">{t.name}</span>
      </Link>
    ),
  },
  {
    key: 'version',
    header: 'Current version',
    render: (t) => (t.current_version !== null ? `v${t.current_version.version_number}` : 'Not published'),
  },
  { key: 'draft', header: 'Draft', render: (t) => (t.draft_version_id !== null ? 'Open' : '—') },
  { key: 'products', header: 'Products', render: (t) => (t.products.length > 0 ? <TagList tags={t.products} max={4} /> : '—') },
  { key: 'updated', header: 'Updated', render: (t) => <time dateTime={t.current_version?.activated_at ?? t.updated_at}>{updatedOf(t)}</time> },
];

export function DocumentTemplatesListView({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const [templates, setTemplates] = useState<PlatformTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await documentTemplatesApi.listTemplates();
      setTemplates(res.templates);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load document templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Document templates</h1>
        {canManage ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create default template
          </Button>
        ) : null}
      </div>
      <p className="pw-panel__sub">
        Aramo default templates are available to every organization. Organizations use the current published version.
      </p>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <DataTable
        columns={COLUMNS}
        rows={templates}
        rowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/document-templates/${t.id}`)}
        emptyMessage={loading ? 'Loading…' : 'No default templates yet.'}
      />

      {creating ? (
        <CreateTemplateDialog
          open={creating}
          onOpenChange={setCreating}
          onDone={(created) => {
            setCreating(false);
            if (created) navigate(`/document-templates/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

export function CreateTemplateDialog({
  open,
  onOpenChange,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (created?: PlatformTemplate) => void;
}) {
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [products, setProducts] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    documentTemplatesApi
      .listDocumentTypes()
      .then((res) => {
        if (!live) return;
        setTypes(res.document_types);
        const first = res.document_types.find((t) => t.configurable) ?? res.document_types[0];
        if (first !== undefined) setTypeId(first.id);
      })
      .catch((e: unknown) => {
        if (live) setError(templateErrorMessage(e, 'Failed to load document types.'));
      });
    return () => {
      live = false;
    };
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const created = await documentTemplatesApi.createTemplate({
        document_type_id: typeId,
        name: name.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        template_kind: 'GENERATED',
        products: parseProductTags(products),
      });
      onOpenChange(false);
      onDone(created);
    } catch (e) {
      setError(templateErrorMessage(e, 'Create failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create default template"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || name.trim().length === 0 || typeId === ''}>
            {busy ? 'Working…' : 'Create'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Document type">
        <Select unstyled aria-label="Document type" className="tc-input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.configurable ? '' : ' (not editable yet)'}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Name">
        <Input unstyled aria-label="Name" className="tc-input" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="Description (optional)">
        <TextArea unstyled aria-label="Description" className="tc-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <FormField label="Products (comma separated, e.g. ATS, SIGN)">
        <Input unstyled aria-label="Products" className="tc-input" value={products} onChange={(e) => setProducts(e.target.value)} />
      </FormField>
    </Dialog>
  );
}
