import {
  DEFAULT_SETTINGS,
  applySettings,
  groupSize,
  settingsFromWire,
  settingsToWire,
  type ConfigurableField,
  type GroupRule,
  type NameMode,
  type PlacementSettings,
  type SettingsPatch,
} from '@aramo/field-placement-web';

import type { EnvelopeField, FieldType } from '../api';

// M-A6 §2 — the Name and Checkbox configuration in the sender editor: the wire mapping
// (stored field ↔ editor settings, and the PUT payload's configuration). FIELD-PARITY-1 P1-5 —
// the editor settings and the check-box group rules (applyConfig / groupSize) moved into the
// shared placement editor (@aramo/field-placement-web), re-exported here under their old names.
// FIELD-PARITY-1 P3 §6.2 — every setting the type takes (the catalog's fieldSettingsOf) now
// travels: label, tooltip, placeholder, read-only, sender-filled with the sender's value,
// validation, font size, data name and options, through the editor's shared wire mapping.

export type { NameMode, GroupRule, ConfigurableField };
export type FieldConfig = PlacementSettings;
export type ConfigPatch = SettingsPatch;
export const DEFAULT_CONFIG: FieldConfig = DEFAULT_SETTINGS;
export const applyConfig = applySettings;
export { groupSize };

/** The configuration members of a PUT field (and `value`, a sender-filled field's own value). */
export type FieldConfigWire = Partial<
  Pick<EnvelopeField, 'name_mode' | 'label' | 'group_key' | 'group_rule' | 'min_selected' | 'tooltip' | 'placeholder' | 'read_only' | 'sender_filled' | 'validation' | 'font_size' | 'data_name' | 'options' | 'value'>
>;

// Stored field → editor config.
export function configFromWire(f: EnvelopeField): FieldConfig {
  return settingsFromWire(f);
}

// Editor config → the PUT payload's configuration for this type. Only the settings the type
// takes and that are set are sent (name_mode always for SIGNER_NAME); a value only for a
// sender-filled field (S-5, ruling R-3 — every other value is refused: sender_value_refused).
export function configToWire(type: FieldType, c: FieldConfig): FieldConfigWire {
  return settingsToWire(type, c, { senderValues: true }) as FieldConfigWire;
}
