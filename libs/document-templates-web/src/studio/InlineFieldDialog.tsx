import { useEffect, useMemo, useState } from 'react';
import {
  FieldSettingsPanel,
  applySettings,
  defaultSettingsFor,
  editableSettingsOf,
  paletteFor,
  typeLabelOf,
  type PlacedField,
  type PlacementCapabilities,
  type SettingsPatch,
} from '@aramo/field-placement-web';
import { FIELD_CATALOG, FIELD_GROUP_KEY_MAX, FIELD_LABEL_MAX, isFieldTypeKey, type FieldSetting } from '@aramo/sign-fields';

import { ConfirmDialog } from './primitives';
import { canBeSenderFilled, signerRolesFor, type StudioInlineField } from './inline-fields';
import type { StudioSigning } from './data-source';

// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) F-14 — "Insert field" in the
// platform Studio: the type (the `template_inline` palette), who fills it (a signer role, or
// "Sender fills it" where the type allows it and the switch is on, F-6 / F-7) and the existing
// FieldSettingsPanel (required, label, tooltip, data name, choices, conditions). No page
// coordinates: the field goes where the caret is. The same dialog edits a placed field, and shows
// a tenant copy's locked field read-only (F-15).

/** The settings a template field row stores (the console template API's set, FIELD-PARITY-1 P3). */
const TEMPLATE_SETTINGS: readonly FieldSetting[] = ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode', 'tooltip', 'placeholder', 'validation', 'font_size', 'data_name', 'options', 'condition'];
const SENDER_SETTINGS: readonly FieldSetting[] = [...TEMPLATE_SETTINGS, 'read_only', 'sender_filled'];
const SENDER = '__sender__';

export interface InlineFieldDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** A placed field (edit / view); null inserts a new one. */
  readonly field: StudioInlineField | null;
  /** The document's other fields (conditions name their triggers). */
  readonly fields: readonly StudioInlineField[];
  readonly signing: StudioSigning | null | undefined;
  /** Sender-filled fields are switched on (the server flag). */
  readonly senderFilledEnabled: boolean;
  /** F-15 — a tenant copy: the field is shown read-only. */
  readonly readOnly: boolean;
  /** A new key for a type (unique in the document). */
  readonly newKey: (type: string) => string;
  readonly onSave: (field: StudioInlineField) => void;
  readonly onDelete?: (key: string) => void;
}

function asPlaced(f: StudioInlineField): PlacedField {
  return { id: f.field_key, type: f.field_type, docId: 'content', page: 0, x: 0, y: 0, width: 0, height: 0, required: f.required, assignee: f.signer_role, binding: null, settings: f.settings };
}

export function InlineFieldDialog(p: InlineFieldDialogProps) {
  const palette = useMemo(() => paletteFor('template_inline'), []);
  const roles = signerRolesFor(p.signing);
  const [draft, setDraft] = useState<StudioInlineField | null>(p.field);
  useEffect(() => {
    if (p.open) setDraft(p.field);
  }, [p.open, p.field]);

  const capabilities: PlacementCapabilities = useMemo(
    () => ({ settings: p.senderFilledEnabled ? SENDER_SETTINGS : TEMPLATE_SETTINGS, limits: { labelMax: FIELD_LABEL_MAX, groupKeyMax: FIELD_GROUP_KEY_MAX } }),
    [p.senderFilledEnabled],
  );

  const choose = (type: string): void => {
    const entry = isFieldTypeKey(type) ? FIELD_CATALOG[type] : null;
    setDraft({
      field_key: p.newKey(type),
      field_type: type,
      signer_role: roles[0]?.role_key ?? null,
      required: entry?.required ?? false,
      settings: defaultSettingsFor(type, p.fields.map(asPlaced)),
    });
  };

  const setRole = (value: string): void => {
    if (draft === null) return;
    if (value === SENDER) setDraft({ ...draft, signer_role: null, settings: { ...draft.settings, senderFilled: true } });
    else setDraft({ ...draft, signer_role: value, settings: { ...draft.settings, senderFilled: false, readOnly: false } });
  };

  const patch = (sp: SettingsPatch): void => {
    if (draft === null) return;
    const [next] = applySettings([asPlaced(draft)], draft.field_key, sp);
    if (next !== undefined) setDraft({ ...draft, required: next.required, settings: next.settings });
  };

  const senderOk = draft !== null && p.senderFilledEnabled && canBeSenderFilled(draft.field_type);
  const roleOk = draft !== null && (draft.signer_role === null ? senderOk && draft.settings.senderFilled : roles.some((r) => r.role_key === draft.signer_role));
  const title = p.readOnly ? 'Field placed by Aramo' : p.field === null ? 'Insert field' : 'Field settings';

  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={title}
      consequence={
        p.readOnly
          ? 'Fields are placed by Aramo. You can edit the wording around them, but not the field itself.'
          : 'The field is placed where the caret is; its position on the page follows the text.'
      }
      commitLabel={p.readOnly ? 'Close' : p.field === null ? 'Insert field' : 'Save field'}
      canCommit={p.readOnly || (draft !== null && roleOk)}
      onCommit={() => {
        if (p.readOnly || draft === null) {
          p.onOpenChange(false);
          return;
        }
        p.onSave(draft);
      }}
    >
      <div className="pws-ifd" data-testid="inline-field-dialog">
        {draft === null && p.readOnly ? (
          <p className="pws-ifd__head">This field is part of the template as Aramo published it.</p>
        ) : draft === null ? (
          <div className="pws-ifd__palette" role="listbox" aria-label="Field type">
            {palette.map((e) => (
              <button key={e.type} type="button" role="option" aria-selected={false} className="pws-ifd__type" data-testid={`inline-field-type-${e.type}`} onClick={() => choose(e.type)}>
                <span aria-hidden="true" className="pws-ifd__glyph">{e.glyph}</span> {e.label}
              </button>
            ))}
          </div>
        ) : (
          <>
            <p className="pws-ifd__head">
              <b>{typeLabelOf(draft.field_type)}</b> <code className="pws-ifd__key">{draft.field_key}</code>
            </p>
            {roles.length === 0 ? <p className="ts-alert ts-alert--warn">Add a signing role first (Roles tab): every field belongs to a signer.</p> : null}
            <label className="fpe-row">
              <span className="fpe-label">Who fills it</span>
              <select
                className="fpe-select"
                disabled={p.readOnly}
                value={draft.signer_role ?? (draft.settings.senderFilled ? SENDER : '')}
                onChange={(e) => setRole(e.target.value)}
                data-testid="inline-field-role"
              >
                {draft.signer_role === null && !draft.settings.senderFilled ? <option value="">Choose…</option> : null}
                {roles.map((r) => (
                  <option key={r.role_key} value={r.role_key}>
                    {r.label}
                  </option>
                ))}
                {senderOk || (draft.signer_role === null && draft.settings.senderFilled) ? <option value={SENDER}>Sender fills it</option> : null}
              </select>
            </label>
            <fieldset disabled={p.readOnly} className="pws-ifd__settings">
              <FieldSettingsPanel
                field={asPlaced(draft)}
                fields={p.fields.filter((f) => f.field_key !== draft.field_key).map(asPlaced).concat(asPlaced(draft))}
                shown={editableSettingsOf(draft.field_type, capabilities)}
                capabilities={capabilities}
                idPrefix="inline-field"
                onChange={patch}
                describe={(f) => `${typeLabelOf(f.type)}${f.settings.label.trim() !== '' ? ` “${f.settings.label.trim()}”` : ''}`}
              />
            </fieldset>
            {!p.readOnly && p.field !== null && p.onDelete !== undefined ? (
              <button type="button" className="pws-ifd__delete" data-testid="inline-field-delete" onClick={() => p.onDelete?.(draft.field_key)}>
                Delete field
              </button>
            ) : null}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
