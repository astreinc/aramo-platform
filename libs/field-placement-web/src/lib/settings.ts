// FIELD-PARITY-1 P1-5 — the inspector's settings rules, moved from apps/sign-web
// workspace/pages/field-config.ts (M-A6 §2) so every host of the shared editor keeps a
// check-box group consistent the same way. Pure helpers, unit-tested on their own.

import { type PlacedField, type PlacementSettings } from './model';

/** An inspector change: any settings plus the required flag. */
export type SettingsPatch = Partial<PlacementSettings> & { readonly required?: boolean };

/** The minimum a configurable field needs (the editor's PlacedField satisfies it). */
export type ConfigurableField = Pick<PlacedField, 'id' | 'type' | 'assignee' | 'required' | 'settings'>;

/**
 * Apply an inspector change to one field, keeping its check-box group consistent: a group
 * belongs to one assignee and shares its rule, minimum and required setting (the server
 * refuses an inconsistent group). Joining an existing group adopts that group's settings;
 * changing a group setting applies it to every box of the group.
 */
export function applySettings<T extends ConfigurableField>(fields: readonly T[], id: string, patch: SettingsPatch): T[] {
  const target = fields.find((f) => f.id === id);
  if (target === undefined) return [...fields];
  const { required, ...settingsPatch } = patch;
  let next: T = { ...target, ...(required !== undefined ? { required } : {}), settings: { ...target.settings, ...settingsPatch } };
  if (next.settings.groupRule === 'SELECT_ONE') next = { ...next, settings: { ...next.settings, minSelected: null } };
  const group = next.type === 'CHECKBOX' ? next.settings.groupKey.trim() : '';
  const sameGroup = (f: T): boolean => f.id !== id && f.type === 'CHECKBOX' && f.assignee === next.assignee && f.settings.groupKey.trim() === group;
  if (group.length > 0 && patch.groupKey !== undefined && target.settings.groupKey.trim() !== group) {
    const peer = fields.find(sameGroup);
    if (peer !== undefined) next = { ...next, required: peer.required, settings: { ...next.settings, groupRule: peer.settings.groupRule, minSelected: peer.settings.minSelected } };
  }
  const shared = group.length > 0 && (patch.groupRule !== undefined || patch.minSelected !== undefined || patch.required !== undefined);
  return fields.map((f) => {
    if (f.id === id) return next;
    if (shared && sameGroup(f)) return { ...f, required: next.required, settings: { ...f.settings, groupRule: next.settings.groupRule, minSelected: next.settings.minSelected } };
    return f;
  });
}

/** The number of boxes in a field's group (the minimum's upper bound). */
export function groupSize(fields: readonly ConfigurableField[], f: ConfigurableField): number {
  const g = f.settings.groupKey.trim();
  if (f.type !== 'CHECKBOX' || g.length === 0) return 1;
  return fields.filter((o) => o.type === 'CHECKBOX' && o.assignee === f.assignee && o.settings.groupKey.trim() === g).length;
}
