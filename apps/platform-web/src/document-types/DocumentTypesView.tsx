import { useCallback, useEffect, useState } from 'react';
import { ApiError, Button, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';
import { ProductTagsSelect, orderedProducts, templateProductLabel, type TemplateProductKey } from '@aramo/document-templates-web';

import {
  ConfirmDialog,
  EmptyState,
  FieldSelect,
  FieldText,
  FieldTextArea,
  Pill,
  Skeleton,
  ViewOnlyNote,
  permissionLabel,
} from '../components';
import { DOC_TEMPLATE_MANAGE_SCOPE } from '../document-templates/document-templates-api';
import '../document-templates/template-variables.css';

import {
  DOCUMENT_TYPE_KIND_LABELS,
  EXECUTION_MODE_LABELS,
  documentTypesApi,
  type DocumentTypeFields,
  type DocumentTypeKind,
  type PlatformDocumentType,
} from './document-types-api';
import './document-types.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4.4 — the Platform Admin
// "Document types" screen. Two sections: Template types (every TEMPLATE row, badged System
// — code depends on it, §4.2 — or Seeded — other seeded rows — or none when created here;
// name, kind, products, category, templates, status) and System upload types (the UPLOAD
// rows, read-only, never offered when creating a template). :manage creates, edits (only the
// fields the server lists as editable), retires and deletes; the server is authoritative for
// every rule (kind fixed / products only added once a template exists, retire refused while
// a default is live, delete only an unreferenced type created here). R10: creating a type
// publishes nothing — a default still needs its own publish.

const NAME_MAX = 120;
const DESC_MAX = 500;
const CATEGORY_MAX = 60;

/** A refusal → the operator copy. */
export function documentTypeErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = e.details?.['reason'];
  switch (reason) {
    case 'key_exists':
      return 'A document type with this name already exists.';
    case 'system_locked':
      return 'Aramo depends on this document type, so this can’t change.';
    case 'upload_type':
      return 'System upload types are read-only.';
    case 'kind_in_use':
      return 'Templates already use this type, so its kind can’t change.';
    case 'product_in_use':
      return 'Templates already use this type, so a product can’t be removed. You can add one.';
    case 'live_default':
      return 'A published Aramo default of this type is live. Withdraw it before retiring the type.';
    case 'in_use':
      return 'Templates or documents use this type, so it can’t be deleted. Retire it instead.';
    case 'seeded':
      return 'Seeded document types can’t be deleted. Retire it instead.';
    case 'products_required':
      return 'Choose at least one product.';
    default:
      return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
  }
}

function kindLine(t: PlatformDocumentType): string {
  if (t.template_kind === null) return 'Not yet available for templates';
  return DOCUMENT_TYPE_KIND_LABELS[t.template_kind];
}

type Confirm = { readonly kind: 'retire' | 'delete'; readonly type: PlatformDocumentType };

export function DocumentTypesView({ session }: { readonly session: Session }) {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useOptionalToast();
  const [data, setData] = useState<{ types: PlatformDocumentType[]; retention: string[]; modes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlatformDocumentType | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await documentTypesApi.list();
      setData({ types: r.document_types, retention: r.retention_classes, modes: r.execution_modes });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Document types couldn’t be loaded. Try again.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const templateTypes = (data?.types ?? []).filter((t) => t.type_class === 'TEMPLATE');
  const uploadTypes = (data?.types ?? []).filter((t) => t.type_class === 'UPLOAD');

  const runConfirm = async (): Promise<void> => {
    if (confirm === null) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === 'retire') await documentTypesApi.retire(confirm.type.id);
      else await documentTypesApi.remove(confirm.type.id);
      toast.show(confirm.kind === 'retire' ? `${confirm.type.name} retired.` : `${confirm.type.name} deleted.`);
      setConfirm(null);
      await load();
    } catch (e) {
      setConfirmError(documentTypeErrorText(e, confirm.kind === 'retire' ? 'Retire failed.' : 'Delete failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pw-tv" data-testid="document-types">
      <div className="pw-tv-head">
        <div>
          <h1 className="pw-tv-title">Document types</h1>
          <p className="pw-tv-intro">
            The kinds of document Aramo templates are written for: which products use them and how they’re signed. Creating a type publishes nothing.
          </p>
        </div>
        {canManage ? (
          <Button unstyled className="pw-btn pw-btn--normal" onClick={() => setEditing('new')}>
            + New document type
          </Button>
        ) : null}
      </div>
      {!canManage ? (
        <div className="pw-tv-viewonly">
          <ViewOnlyNote permission={permissionLabel(DOC_TEMPLATE_MANAGE_SCOPE)} subject="document types" needs="Changing them needs" />
        </div>
      ) : null}
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error pw-dt-alert">
          {error}
        </div>
      ) : null}

      <h2 className="pw-dt-h2">Template types</h2>
      <div className="pw-tv-card">
        <div className="pw-tv-scroll">
          <table className="pw-tv-table pw-dt-table" aria-label="Template types">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Products</th>
                <th>Category</th>
                <th>Templates</th>
                <th>Status</th>
                <th>
                  <span className="pw-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data === null && error === null
                ? [0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {[180, 90, 70, 90, 40, 60, 80].map((w, j) => (
                        <td key={j}>
                          <Skeleton width={w} />
                        </td>
                      ))}
                    </tr>
                  ))
                : null}
              {templateTypes.map((t) => {
                const editable = t.editable_fields.length > 0;
                const canRetire = t.active && t.badge !== 'SYSTEM';
                const canDelete = t.badge === null && t.templates_count === 0;
                return (
                  <tr key={t.id} data-testid={`doctype-${t.key}`}>
                    <td>
                      <b className="pw-tv-label">{t.name}</b>
                      {t.badge !== null ? (
                        <span className="pw-dt-badge">
                          <Pill tone={t.badge === 'SYSTEM' ? 'info' : 'neutral'} size="sm" dot={false}>
                            {t.badge === 'SYSTEM' ? 'System' : 'Seeded'}
                          </Pill>
                        </span>
                      ) : null}
                      <div className="pw-tv-key pw-dt-key">{t.key}</div>
                    </td>
                    <td className={t.template_kind === null ? 'pw-dt-muted' : 'pw-tv-text'}>{kindLine(t)}</td>
                    <td>
                      <span className="pw-tv-products">
                        {orderedProducts(t.products).map((p) => (
                          <span key={p} className="pw-tv-product">
                            {templateProductLabel(p)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="pw-tv-text">{t.category ?? '—'}</td>
                    <td className="pw-tv-text">{t.templates_count}</td>
                    <td>
                      <Pill tone={t.active ? 'ok' : 'muted'}>{t.active ? 'Active' : 'Retired'}</Pill>
                    </td>
                    <td className="pw-tv-actions pw-dt-actions">
                      {canManage && editable ? (
                        <Button unstyled className="pw-tv-edit" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                          Edit
                        </Button>
                      ) : null}
                      {canManage && canRetire ? (
                        <Button
                          unstyled
                          className="pw-tv-edit"
                          aria-label={`Retire ${t.name}`}
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: 'retire', type: t });
                          }}
                        >
                          Retire…
                        </Button>
                      ) : null}
                      {canManage && canDelete ? (
                        <Button
                          unstyled
                          className="pw-tv-edit"
                          aria-label={`Delete ${t.name}`}
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: 'delete', type: t });
                          }}
                        >
                          Delete…
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data !== null && templateTypes.length === 0 ? <EmptyState size="lg" title="No template types yet" body="Create one to author Aramo defaults for it." /> : null}
      </div>

      <h2 className="pw-dt-h2">System upload types</h2>
      <p className="pw-dt-note">Upload slots for documents people attach, such as a résumé. Read-only, and never offered when creating a template.</p>
      <div className="pw-tv-card">
        <div className="pw-tv-scroll">
          <table className="pw-tv-table pw-dt-table pw-dt-table--narrow" aria-label="System upload types">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Retention</th>
              </tr>
            </thead>
            <tbody>
              {uploadTypes.map((t) => (
                <tr key={t.id} data-testid={`doctype-${t.key}`}>
                  <td className="pw-tv-label">{t.name}</td>
                  <td className="pw-tv-key">{t.key}</td>
                  <td className="pw-tv-text">{t.retention_class}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== null && data !== null ? (
        <DocumentTypeDialog
          type={editing === 'new' ? null : editing}
          retentionClasses={data.retention}
          executionModes={data.modes}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            toast.show(created ? 'Document type created.' : 'Document type saved.');
            void load();
          }}
        />
      ) : null}
      {confirm !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirm(null);
          }}
          title={confirm.kind === 'retire' ? `Retire ${confirm.type.name}?` : `Delete ${confirm.type.name}?`}
          consequence={
            confirm.kind === 'retire'
              ? 'It is no longer offered when creating a template. Templates and documents that use it keep working.'
              : 'The document type is deleted. Nothing uses it. This can’t be undone.'
          }
          tone="privileged"
          commitLabel={confirm.kind === 'retire' ? 'Retire type' : 'Delete type'}
          busy={busy}
          error={confirmError}
          onCommit={() => void runConfirm()}
        />
      ) : null}
    </div>
  );
}

/**
 * §4.4 — the create / edit dialog: name, description, category, kind (Editable / Fixed form),
 * products (dropdown, ≥1), retention class (existing values), signing (execution mode). On
 * edit only the fields the server lists as editable can change (system-locked types, §4.2);
 * the others are shown disabled.
 */
export function DocumentTypeDialog({
  type,
  retentionClasses,
  executionModes,
  onClose,
  onSaved,
}: {
  readonly type: PlatformDocumentType | null;
  readonly retentionClasses: readonly string[];
  readonly executionModes: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: (created: boolean) => void;
}) {
  const creating = type === null;
  const can = (f: string): boolean => creating || (type?.editable_fields.includes(f) ?? false);
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [category, setCategory] = useState(type?.category ?? '');
  const [kind, setKind] = useState<DocumentTypeKind | ''>(type?.template_kind ?? (creating ? 'EDITABLE' : ''));
  const [products, setProducts] = useState<TemplateProductKey[]>(type !== null ? [...type.products] : ['sign']);
  const [retention, setRetention] = useState(type?.retention_class ?? (retentionClasses.includes('CONTRACT_RECORD') ? 'CONTRACT_RECORD' : (retentionClasses[0] ?? '')));
  const [mode, setMode] = useState(type?.execution_mode_default ?? 'SINGLE_SIGNATURE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ok = name.trim() !== '' && kind !== '' && (!can('products') || products.length > 0) && retention !== '' && mode !== '';

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const fields: DocumentTypeFields = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      category: category.trim() === '' ? null : category.trim(),
      template_kind: kind as DocumentTypeKind,
      products,
      retention_class: retention,
      execution_mode_default: mode,
    };
    try {
      if (type === null) await documentTypesApi.create(fields);
      else {
        // Only the fields this type allows (§4.2); the server re-checks every one.
        const patch = Object.fromEntries(Object.entries(fields).filter(([k]) => type.editable_fields.includes(k))) as Partial<DocumentTypeFields>;
        await documentTypesApi.update(type.id, patch);
      }
      onSaved(creating);
    } catch (e) {
      setError(documentTypeErrorText(e, 'The document type couldn’t be saved. Try again.'));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={creating ? 'New document type' : `Edit ${type.name}`}
      consequence={
        creating
          ? 'Creates a template type in Platform Admin. Nothing is published: an Aramo default for it is created and published separately.'
          : type.templates_count > 0
            ? 'Templates use this type: its kind is fixed and products can only be added.'
            : 'Changes apply to new templates of this type.'
      }
      commitLabel={creating ? 'Create type' : 'Save type'}
      canCommit={ok}
      busy={busy}
      error={error}
      onCommit={() => void commit()}
    >
      <FieldText label="Name" required value={name} onChange={(v) => setName(v.slice(0, NAME_MAX))} maxLength={NAME_MAX} disabled={!can('name')} />
      {can('description') ? (
        <FieldTextArea label="Description (optional)" value={description} onChange={setDescription} max={DESC_MAX} />
      ) : null}
      <FieldText label="Category (optional)" value={category} onChange={(v) => setCategory(v.slice(0, CATEGORY_MAX))} maxLength={CATEGORY_MAX} disabled={!can('category')} />
      {can('template_kind') ? (
        <FieldSelect
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as DocumentTypeKind)}
          options={[
            ...(kind === '' ? [{ value: '', label: 'Choose a kind' }] : []),
            { value: 'EDITABLE', label: DOCUMENT_TYPE_KIND_LABELS.EDITABLE },
            { value: 'FIXED_FORM', label: DOCUMENT_TYPE_KIND_LABELS.FIXED_FORM },
          ]}
        />
      ) : (
        <FieldText label="Kind" value={kind === '' ? 'Not yet available for templates' : DOCUMENT_TYPE_KIND_LABELS[kind]} onChange={() => undefined} disabled />
      )}
      <ProductTagsSelect
        label="Products"
        value={products}
        onChange={setProducts}
        disabled={!can('products')}
        fieldClassName="pw-field"
        labelClassName="pw-field__label"
        helperClassName="pw-field__helper"
        helper="Templates of this type can be tagged with these products. At least one."
      />
      <FieldSelect
        label="Retention class"
        value={retention}
        onChange={setRetention}
        options={retentionClasses.map((r) => ({ value: r, label: r, disabled: !can('retention_class') && r !== retention }))}
      />
      <FieldSelect
        label="Signing"
        value={mode}
        onChange={setMode}
        options={executionModes.map((m) => ({ value: m, label: EXECUTION_MODE_LABELS[m] ?? m, disabled: !can('execution_mode_default') && m !== mode }))}
      />
    </ConfirmDialog>
  );
}
