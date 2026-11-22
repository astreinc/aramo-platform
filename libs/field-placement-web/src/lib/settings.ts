// FIELD-PARITY-1 P1-5 — the inspector's settings rules, moved from apps/sign-web
// workspace/pages/field-config.ts (M-A6 §2) so every host of the shared editor keeps a
// check-box group consistent the same way. Pure helpers, unit-tested on their own.
//
// FIELD-PARITY-1 P3 §6 — a RADIO is one option of a radio group (T-5): groups are now check-box
// groups and radio groups, never mixed. A group belongs to one assignee and shares its rule,
// minimum, required, read-only and sender-filled settings (the server's checkboxGroupIssues); a
// radio group's rule is always SELECT_ONE, and choosing one option as the sender's value clears
// the others.

import { isGroupedType, type PlacedField, type PlacementSettings } from './model';

/** An inspector change: any settings plus the required flag. */
export type SettingsPatch = Partial<PlacementSettings> & { readonly required?: boolean };

/** The minimum a configurable field needs (the editor's PlacedField satisfies it). */
export type ConfigurableField = Pick<PlacedField, 'id' | 'type' | 'assignee' | 'required' | 'settings'>;

/** The settings every field of a group shares (with `required`). */
const GROUP_SHARED = ['groupRule', 'minSelected', 'readOnly', 'senderFilled'] as const;

/**
 * Apply an inspector change to one field, keeping its group consistent: a group belongs to one
 * assignee and one type and shares its rule, minimum, required, read-only and sender-filled
 * settings (the server refuses an inconsistent group). Joining an existing group adopts that
 * group's settings; changing a group setting applies it to every field of the group.
 */
export function applySettings<T extends ConfigurableField>(fields: readonly T[], id: string, patch: SettingsPatch): T[] {
  const target = fields.find((f) => f.id === id);
  if (target === undefined) return [...fields];
  const { required, ...settingsPatch } = patch;
  let next: T = { ...target, ...(required !== undefined ? { required } : {}), settings: { ...target.settings, ...settingsPatch } };
  if (next.type === 'RADIO') next = { ...next, settings: { ...next.settings, groupRule: 'SELECT_ONE' } };
  if (next.settings.groupRule === 'SELECT_ONE') next = { ...next, settings: { ...next.settings, minSelected: null } };
  // S-4 — read-only only together with sender-filled; a field no longer sender-filled loses its value.
  if (!next.settings.senderFilled) next = { ...next, settings: { ...next.settings, readOnly: false, senderValue: '' } };
  const group = isGroupedType(next.type) ? next.settings.groupKey.trim() : '';
  const sameGroup = (f: T): boolean => f.id !== id && f.type === next.type && f.assignee === next.assignee && f.settings.groupKey.trim() === group;
  if (group.length > 0 && patch.groupKey !== undefined && target.settings.groupKey.trim() !== group) {
    const peer = fields.find(sameGroup);
    if (peer !== undefined) {
      const adopted = Object.fromEntries(GROUP_SHARED.map((k) => [k, peer.settings[k]])) as Pick<PlacementSettings, (typeof GROUP_SHARED)[number]>;
      next = { ...next, required: peer.required, settings: { ...next.settings, ...adopted, ...(adopted.senderFilled ? {} : { senderValue: '' }) } };
    }
  }
  const shared = group.length > 0 && (patch.required !== undefined || GROUP_SHARED.some((k) => patch[k] !== undefined));
  // A radio group holds one chosen option: the sender choosing this one clears the others.
  const radioChosen = next.type === 'RADIO' && group.length > 0 && patch.senderValue === 'true';
  return fields.map((f) => {
    if (f.id === id) return next;
    if (!sameGroup(f)) return f;
    let out = f;
    if (shared) {
      const s = Object.fromEntries(GROUP_SHARED.map((k) => [k, next.settings[k]])) as Pick<PlacementSettings, (typeof GROUP_SHARED)[number]>;
      out = { ...out, required: next.required, settings: { ...out.settings, ...s, ...(s.senderFilled ? {} : { senderValue: '' }) } };
    }
    if (radioChosen && out.settings.senderValue === 'true') out = { ...out, settings: { ...out.settings, senderValue: 'false' } };
    return out;
  });
}

/** The number of fields in a field's group (the minimum's upper bound). */
export function groupSize(fields: readonly ConfigurableField[], f: ConfigurableField): number {
  const g = f.settings.groupKey.trim();
  if (!isGroupedType(f.type) || g.length === 0) return 1;
  return fields.filter((o) => o.type === f.type && o.assignee === f.assignee && o.settings.groupKey.trim() === g).length;
}
