import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  FormField,
  InlineAlert,
  Input,
  Select,
  TagList,
  TextArea,
  hasScope,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  TEMPLATE_VARIABLE_DATA_TYPES,
  documentTemplatesApi,
  parseProductTags,
  type TemplateVariable,
  type TemplateVariableDataType,
} from './document-templates-api';
import { templateErrorMessage } from './template-errors';

// DOC-TEMPLATE-LIB-1 T-2 (§8.1; ADR-0034 D7) — the Aramo-maintained template variable
// catalog. Templates may only use variables listed here; ATS fills a variable from the
// resolver named by its ATS binding key. The key is the token stored in template content
// and is immutable once created. Create/edit is manage-gated.

export function TemplateVariablesView({ session }: { readonly session: Session }) {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const [rows, setRows] = useState<TemplateVariable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TemplateVariable | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await documentTemplatesApi.listVariables()).variables);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load template variables.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ReadonlyArray<TableColumn<TemplateVariable>> = [
    { key: 'key', header: 'Key', render: (v) => <span className="mono">{v.key}</span> },
    { key: 'label', header: 'Label', render: (v) => v.label },
    { key: 'group', header: 'Group', render: (v) => v.group_label },
    { key: 'type', header: 'Type', render: (v) => v.data_type },
    { key: 'products', header: 'Products', render: (v) => (v.products.length > 0 ? <TagList tags={v.products} max={4} /> : '—') },
    { key: 'ats', header: 'ATS binding', render: (v) => (v.ats_binding_key !== null ? <span className="mono">{v.ats_binding_key}</span> : '—') },
    { key: 'sample', header: 'Sample', render: (v) => v.sample_value ?? '—' },
    { key: 'active', header: 'Status', render: (v) => (v.active ? 'Active' : 'Inactive') },
    ...(canManage
      ? [
          {
            key: 'edit',
            header: '',
            render: (v: TemplateVariable) => (
              <Button variant="secondary" size="sm" aria-label={`Edit ${v.key}`} onClick={() => setEditing(v)}>
                Edit
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Template variables</h1>
        {canManage ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add variable
          </Button>
        ) : null}
      </div>
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(v) => v.id}
        rowMuted={(v) => !v.active}
        emptyMessage={loading ? 'Loading…' : 'No variables yet.'}
      />
      {editing !== null ? (
        <VariableDialog
          variable={editing === 'new' ? null : editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void load();
          }}
        />
      ) : null}
    </div>
  );
}

export function VariableDialog({
  variable,
  onClose,
}: {
  readonly variable: TemplateVariable | null;
  readonly onClose: (changed: boolean) => void;
}) {
  const [key, setKey] = useState(variable?.key ?? '');
  const [label, setLabel] = useState(variable?.label ?? '');
  const [group, setGroup] = useState(variable?.group_label ?? '');
  const [dataType, setDataType] = useState<TemplateVariableDataType>(variable?.data_type ?? 'TEXT');
  const [products, setProducts] = useState((variable?.products ?? []).join(', '));
  const [atsKey, setAtsKey] = useState(variable?.ats_binding_key ?? '');
  const [sample, setSample] = useState(variable?.sample_value ?? '');
  const [active, setActive] = useState(variable?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const fields = {
      label: label.trim(),
      group_label: group.trim(),
      data_type: dataType,
      products: parseProductTags(products),
      ats_binding_key: atsKey.trim().length > 0 ? atsKey.trim() : null,
      sample_value: sample.trim().length > 0 ? sample : null,
      active,
    };
    try {
      if (variable === null) await documentTemplatesApi.createVariable({ key: key.trim(), ...fields });
      else await documentTemplatesApi.updateVariable(variable.id, fields);
      onClose(true);
    } catch (e) {
      setError(templateErrorMessage(e, 'Save failed.'));
      setBusy(false);
    }
  };

  const title = variable === null ? 'Add variable' : `Edit ${variable.key}`;
  const disabled = busy || label.trim() === '' || group.trim() === '' || (variable === null && key.trim() === '');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={disabled}>
            {busy ? 'Working…' : 'Save'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Key (cannot be changed later)">
        <Input
          unstyled
          aria-label="Key"
          className="tc-input mono"
          value={key}
          readOnly={variable !== null}
          placeholder="e.g. organization.address_line1"
          onChange={(e) => setKey(e.target.value)}
        />
      </FormField>
      <FormField label="Label">
        <Input unstyled aria-label="Label" className="tc-input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </FormField>
      <FormField label="Group">
        <Input unstyled aria-label="Group" className="tc-input" value={group} onChange={(e) => setGroup(e.target.value)} />
      </FormField>
      <FormField label="Data type">
        <Select unstyled aria-label="Data type" className="tc-input" value={dataType} onChange={(e) => setDataType(e.target.value as TemplateVariableDataType)}>
          {TEMPLATE_VARIABLE_DATA_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Products (comma separated)">
        <Input unstyled aria-label="Products" className="tc-input" value={products} onChange={(e) => setProducts(e.target.value)} />
      </FormField>
      <FormField label="ATS binding key (optional)">
        <Input unstyled aria-label="ATS binding key" className="tc-input mono" value={atsKey} onChange={(e) => setAtsKey(e.target.value)} />
      </FormField>
      <FormField label="Sample value for previews (optional)">
        <TextArea unstyled aria-label="Sample value" className="tc-input" rows={2} value={sample} onChange={(e) => setSample(e.target.value)} />
      </FormField>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox aria-label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>Active</span>
      </label>
    </Dialog>
  );
}
