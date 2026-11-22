import { DEFAULT_SETTINGS, applySettings, groupSize, type ConfigurableField, type GroupRule, type NameMode, type PlacementSettings, type SettingsPatch } from '@aramo/field-placement-web';

import type { EnvelopeField, FieldType } from '../api';

// M-A6 §2 — the Name and Checkbox configuration in the sender editor: the wire mapping
// (stored field ↔ editor settings, and the PUT payload's configuration). FIELD-PARITY-1 P1-5 —
// the editor settings and the check-box group rules (applyConfig / groupSize) moved into the
// shared placement editor (@aramo/field-placement-web), re-exported here under their old names.

export type { NameMode, GroupRule, ConfigurableField };
export type FieldConfig = PlacementSettings;
export type ConfigPatch = SettingsPatch;
export const DEFAULT_CONFIG: FieldConfig = DEFAULT_SETTINGS;
export const applyConfig = applySettings;
export { groupSize };

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
