import { useCallback, useEffect, useState } from 'react';
import { ApiError, Button, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import {
  ConfirmDialog,
  EmptyState,
  FieldSelect,
  FieldText,
  Pill,
  Skeleton,
  TagInput,
  ViewOnlyNote,
  permissionLabel,
  type FieldSelectOption,
} from '../components';

import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  TEMPLATE_VARIABLE_DATA_TYPES,
  documentTemplatesApi,
  type TemplateVariable,
  type TemplateVariableDataType,
} from './document-templates-api';
import './template-variables.css';

// PLATFORM-UX-1 F-8 (handoff §9 Template variables) — the Aramo-maintained
// template variable catalog (DOC-TEMPLATE-LIB-1 T-2; ADR-0034 D7). Templates may
// only use variables listed here; ATS fills a variable from the resolver named by
// its ATS binding key. The key is the token stored in template content and can't
// change after creation (the field is disabled when editing). Add/Edit are gated
// on platform:document_template:manage; read-scope operators see the view-only
// note (handoff §2).

export const VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const VARIABLE_KEY_MAX = 64;

export const KEY_SHAPE_ERROR = 'Key must look like a.b_c: lowercase segments separated by dots, up to 64 characters.';
export const KEY_EXISTS_ERROR = 'A variable with this key already exists.';
export const BINDING_SHAPE_ERROR = 'ATS binding must look like a.b_c: lowercase segments separated by dots, up to 64 characters.';

/** The design's groups (Platform Admin.dc.html varDlg). */
export const VARIABLE_GROUPS = ['Talent', 'Requisition', 'Offer', 'Organization', 'Document'] as const;

/** "MULTILINE_TEXT" → "Multiline text" (the Data type select). */
export function dataTypeLabel(t: string): string {
  return t.replace('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** "MULTILINE_TEXT" → "MULTILINE TEXT" (the table's mono Type column). */
export function dataTypeCode(t: string): string {
  return t.replace('_', ' ');
}

export function keyIsValid(key: string): boolean {
  return key.length <= VARIABLE_KEY_MAX && VARIABLE_KEY_PATTERN.test(key);
}

/** A create/update refusal → the operator copy. */
export function variableErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = e.details?.['reason'];
  if (reason === 'key_exists') return KEY_EXISTS_ERROR;
  if (reason === 'invalid_key') return /ats_binding/i.test(e.message) ? BINDING_SHAPE_ERROR : KEY_SHAPE_ERROR;
  if (reason === 'key_immutable') return 'The key can’t change after creation.';
  return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
}

export function TemplateVariablesView({ session }: { readonly session: Session }) {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useOptionalToast();
  const [rows, setRows] = useState<TemplateVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TemplateVariable | 'new' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await documentTemplatesApi.listVariables()).variables);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Template variables couldn’t be loaded. Try again.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="pw-tv" data-testid="template-variables">
      <div className="pw-tv-head">
        <div>
          <h1 className="pw-tv-title">Template variables</h1>
          <p className="pw-tv-intro">Variables that templates can insert, with their data type and sample value.</p>
        </div>
        {canManage ? (
          <Button unstyled className="pw-btn pw-btn--normal" onClick={() => setEditing('new')}>
            + Add variable
          </Button>
        ) : null}
      </div>
      {!canManage ? (
        <div className="pw-tv-viewonly">
          <ViewOnlyNote
            permission={permissionLabel(DOC_TEMPLATE_MANAGE_SCOPE)}
            subject="the variable catalog"
            needs="Adding or editing a variable needs"
          />
        </div>
      ) : null}
      <div className="pw-tv-card">
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-tv-card__alert">
            {error}
          </div>
        ) : null}
        <div className="pw-tv-scroll">
          <table className="pw-tv-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Group</th>
                <th>Type</th>
                <th>Products</th>
                <th>ATS binding</th>
                <th>Sample</th>
                <th>Status</th>
                <th>
                  <span className="pw-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows === null && error === null
                ? [0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {[150, 120, 80, 50, 60, 110, 90, 60, 40].map((w, j) => (
                        <td key={j}>
                          <Skeleton width={w} />
                        </td>
                      ))}
                    </tr>
                  ))
                : null}
              {(rows ?? []).map((v) => {
                const p = v.active ? { label: 'Active', tone: 'ok' as const } : { label: 'Inactive', tone: 'muted' as const };
                return (
                  <tr key={v.id} data-testid={`variable-${v.key}`}>
                    <td className="pw-tv-key">{v.key}</td>
                    <td className="pw-tv-label">{v.label}</td>
                    <td className="pw-tv-text">{v.group_label}</td>
                    <td className="pw-tv-type">{dataTypeCode(v.data_type)}</td>
                    <td>
                      <span className="pw-tv-products">
                        {v.products.map((g) => (
                          <span key={g} className="pw-tv-product">
                            {g}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="pw-tv-bind">{v.ats_binding_key ?? '—'}</td>
                    <td className="pw-tv-text">{v.sample_value ?? '—'}</td>
                    <td>
                      <Pill tone={p.tone}>{p.label}</Pill>
                    </td>
                    <td className="pw-tv-actions">
                      {canManage ? (
                        <Button unstyled className="pw-tv-edit" aria-label={`Edit ${v.key}`} onClick={() => setEditing(v)}>
                          Edit
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows !== null && rows.length === 0 ? (
          <EmptyState size="lg" title="No variables yet" body="Variables you add here become available to every template." />
        ) : null}
      </div>
      {editing !== null ? (
        <VariableDialog
          variable={editing === 'new' ? null : editing}
          existingKeys={(rows ?? []).map((r) => r.key)}
          onClose={() => setEditing(null)}
          onSaved={(added) => {
            setEditing(null);
            toast.show(added ? 'Variable added.' : 'Variable saved.');
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

export function VariableDialog({
  variable,
  existingKeys,
  onClose,
  onSaved,
}: {
  readonly variable: TemplateVariable | null;
  readonly existingKeys: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: (added: boolean) => void;
}) {
  const creating = variable === null;
  const [key, setKey] = useState(variable?.key ?? '');
  const [label, setLabel] = useState(variable?.label ?? '');
  const [group, setGroup] = useState(variable?.group_label ?? '');
  const [dataType, setDataType] = useState<TemplateVariableDataType>(variable?.data_type ?? 'TEXT');
  const [products, setProducts] = useState<string[]>(variable ? [...variable.products] : ['ATS']);
  const [binding, setBinding] = useState(variable?.ats_binding_key ?? '');
  const [sample, setSample] = useState(variable?.sample_value ?? '');
  const [active, setActive] = useState(variable?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groupOptions: FieldSelectOption[] = [
    { value: '', label: 'Choose a group' },
    ...VARIABLE_GROUPS.map((g) => ({ value: g, label: g })),
    // An existing variable's group outside the design's list stays selectable.
    ...(group !== '' && !(VARIABLE_GROUPS as readonly string[]).includes(group) ? [{ value: group, label: group }] : []),
  ];

  const canCommit =
    (!creating || key.trim() !== '') && label.trim() !== '' && group.trim() !== '' && sample.trim() !== '';

  const commit = async (): Promise<void> => {
    const k = key.trim();
    if (creating) {
      if (!keyIsValid(k)) return setError(KEY_SHAPE_ERROR);
      if (existingKeys.includes(k)) return setError(KEY_EXISTS_ERROR);
    }
    const b = binding.trim();
    if (b !== '' && !keyIsValid(b)) return setError(BINDING_SHAPE_ERROR);
    setBusy(true);
    setError(null);
    const fields = {
      label: label.trim(),
      group_label: group.trim(),
      data_type: dataType,
      products,
      ats_binding_key: b !== '' ? b : null,
      sample_value: sample,
    };
    try {
      if (variable === null) await documentTemplatesApi.createVariable({ key: k, ...fields, active: true });
      else await documentTemplatesApi.updateVariable(variable.id, { ...fields, active });
      onSaved(creating);
    } catch (e) {
      setError(variableErrorText(e, 'The variable couldn’t be saved. Try again.'));
      setBusy(false);
    }
  };

  const edit = <T,>(set: (v: T) => void) => (v: T): void => {
    set(v);
    setError(null);
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={variable === null ? 'Add variable' : `Edit ${variable.key}`}
      consequence={
        creating
          ? 'Keys use dotted lowercase segments, for example talent.first_name. The key can’t change later.'
          : 'The key can’t change after creation.'
      }
      error={error}
      commitLabel={creating ? 'Add variable' : 'Save variable'}
      canCommit={canCommit}
      busy={busy}
      onCommit={() => void commit()}
    >
      <FieldText label="Key" value={key} onChange={edit(setKey)} mono disabled={!creating} maxLength={VARIABLE_KEY_MAX} />
      <FieldText label="Label" value={label} onChange={edit(setLabel)} />
      <FieldSelect label="Group" value={group} onChange={edit(setGroup)} options={groupOptions} />
      <FieldSelect
        label="Data type"
        value={dataType}
        onChange={edit((v: string) => setDataType(v as TemplateVariableDataType))}
        options={TEMPLATE_VARIABLE_DATA_TYPES.map((t) => ({ value: t, label: dataTypeLabel(t) }))}
      />
      <TagInput label="Products" tags={products} onChange={edit(setProducts)} />
      <FieldText label="ATS binding (optional)" value={binding} onChange={edit(setBinding)} mono maxLength={VARIABLE_KEY_MAX} />
      <FieldText label="Sample value" value={sample} onChange={edit(setSample)} />
      {!creating ? (
        <FieldSelect
          label="Status"
          value={active ? 'ACTIVE' : 'INACTIVE'}
          onChange={edit((v: string) => setActive(v === 'ACTIVE'))}
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'INACTIVE', label: 'Inactive' },
          ]}
        />
      ) : null}
    </ConfirmDialog>
  );
}
