import type { EnvelopeField, FieldType } from '../api';

// M-A6 §2 — the Name and Checkbox configuration in the sender editor. Pure
// helpers (the editor state and the PUT payload), unit-tested on their own.

export type NameMode = 'SIGNER_PROFILE' | 'SIGNER_ENTERED';
export type GroupRule = 'SELECT_ONE' | 'SELECT_ANY';

export interface FieldConfig {
  // SIGNER_NAME — the server fills the signer's name (SIGNER_PROFILE, default),
  // or the signer types it.
  nameMode: NameMode;
  // CHECKBOX — caption, group key ('' = no group), rule and minimum.
  label: string;
  groupKey: string;
  groupRule: GroupRule;
  minSelected: number | null;
}

export interface ConfigurableField extends FieldConfig {
  key: string;
  signerId: string;
  type: FieldType;
  required: boolean;
}

export const DEFAULT_CONFIG: FieldConfig = { nameMode: 'SIGNER_PROFILE', label: '', groupKey: '', groupRule: 'SELECT_ANY', minSelected: null };

// Stored field → editor config.
export function configFromWire(f: EnvelopeField): FieldConfig {
  return {
    nameMode: f.name_mode === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : 'SIGNER_PROFILE',
    label: f.label ?? '',
    groupKey: f.group_key ?? '',
    groupRule: f.group_rule === 'SELECT_ONE' ? 'SELECT_ONE' : 'SELECT_ANY',
    minSelected: f.min_selected ?? null,
  };
}

// Editor config → the PUT payload's configuration for this type. Only the
// properties the type takes are sent; a value is never sent (§2.2).
export function configToWire(type: FieldType, c: FieldConfig): Partial<Pick<EnvelopeField, 'name_mode' | 'label' | 'group_key' | 'group_rule' | 'min_selected'>> {
  if (type === 'SIGNER_NAME') return { name_mode: c.nameMode };
  if (type !== 'CHECKBOX') return {};
  const label = c.label.trim();
  const group = c.groupKey.trim();
  return {
    ...(label.length > 0 ? { label } : {}),
    ...(group.length > 0
      ? { group_key: group, group_rule: c.groupRule, ...(c.groupRule === 'SELECT_ANY' && c.minSelected !== null ? { min_selected: c.minSelected } : {}) }
      : {}),
  };
}

export type ConfigPatch = Partial<FieldConfig> & { required?: boolean };

// Apply an inspector change to one field, keeping its check-box group
// consistent: a group belongs to one recipient and shares its rule, minimum and
// required setting (the server refuses an inconsistent group). Joining an
// existing group adopts that group's settings; changing a group setting applies
// it to every box of the group.
export function applyConfig<T extends ConfigurableField>(fields: readonly T[], key: string, patch: ConfigPatch): T[] {
  const target = fields.find((f) => f.key === key);
  if (target === undefined) return [...fields];
  let next: T = { ...target, ...patch };
  if (next.groupRule === 'SELECT_ONE') next = { ...next, minSelected: null };
  const group = next.type === 'CHECKBOX' ? next.groupKey.trim() : '';
  const sameGroup = (f: T) => f.key !== key && f.type === 'CHECKBOX' && f.signerId === next.signerId && f.groupKey.trim() === group;
  if (group.length > 0 && patch.groupKey !== undefined && target.groupKey.trim() !== group) {
    const peer = fields.find(sameGroup);
    if (peer !== undefined) next = { ...next, groupRule: peer.groupRule, minSelected: peer.minSelected, required: peer.required };
  }
  const shared = group.length > 0 && (patch.groupRule !== undefined || patch.minSelected !== undefined || patch.required !== undefined);
  return fields.map((f) => {
    if (f.key === key) return next;
    if (shared && sameGroup(f)) return { ...f, groupRule: next.groupRule, minSelected: next.minSelected, required: next.required };
    return f;
  });
}

// The number of boxes in a field's group (for the minimum's upper bound).
export function groupSize(fields: readonly ConfigurableField[], f: ConfigurableField): number {
  const g = f.groupKey.trim();
  if (f.type !== 'CHECKBOX' || g.length === 0) return 1;
  return fields.filter((o) => o.type === 'CHECKBOX' && o.signerId === f.signerId && o.groupKey.trim() === g).length;
}
