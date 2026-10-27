import type { StudioChipInfo } from '../studio-codec';

import type { StudioAllowedBinding, StudioCatalogVariable } from './data-source';

// PLATFORM-UX-1 F-9 (handoff §10.4 chip states, §10.6 Variables) — the Studio's view of
// the variable catalog (GET /platform/template-variables) and of the keys this
// document type can bind (GET …/:id/allowed-bindings — the server's closed set):
//   known    = bindable for this template (the server accepts it on save)
//   inactive = in the catalog but inactive (renders its sample; tenants can't bind it)
//   unknown  = not in the catalog, or not bindable for this document type.

export interface StudioVariable {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly type: string; // data type, lower-cased ("multiline text")
  readonly sample: string;
  readonly active: boolean;
  /** Bindable for this document type (Insert / drag offered). */
  readonly insertable: boolean;
}

export interface VariableCatalog {
  readonly list: readonly StudioVariable[];
  readonly groups: readonly string[];
  readonly byKey: ReadonlyMap<string, StudioVariable>;
  readonly allowed: ReadonlySet<string>;
}

export function typeLabel(dataType: string): string {
  return dataType.replace(/_/g, ' ').toLowerCase();
}

export function buildCatalog(variables: readonly StudioCatalogVariable[], bindings: readonly StudioAllowedBinding[]): VariableCatalog {
  const allowed = new Set(bindings.map((b) => b.key));
  const list: StudioVariable[] = variables.map((v) => ({
    key: v.key,
    label: v.label,
    group: v.group_label,
    type: typeLabel(v.data_type),
    sample: v.sample_value ?? '',
    active: v.active,
    insertable: v.active && allowed.has(v.key),
  }));
  // A bindable key the catalog list does not carry still shows (server label + group).
  for (const b of bindings) {
    if (!list.some((v) => v.key === b.key)) {
      list.push({ key: b.key, label: b.label, group: b.group, type: '', sample: '', active: true, insertable: true });
    }
  }
  const groups: string[] = [];
  for (const v of list) if (!groups.includes(v.group)) groups.push(v.group);
  return { list, groups, byKey: new Map(list.map((v) => [v.key, v])), allowed };
}

export const EMPTY_CATALOG: VariableCatalog = { list: [], groups: [], byKey: new Map(), allowed: new Set() };

export function chipInfo(cat: VariableCatalog, key: string): StudioChipInfo {
  const v = cat.byKey.get(key);
  if (v !== undefined && cat.allowed.has(key) && v.active) {
    return { state: 'known', title: `${v.label} · e.g. ${v.sample}` };
  }
  if (v !== undefined && !v.active) return { state: 'inactive', title: `${v.label} · e.g. ${v.sample} · inactive` };
  if (v !== undefined) return { state: 'unknown', title: `${v.label} · not available for this document type` };
  return { state: 'unknown', title: 'Unknown variable — not in Template variables' };
}

/** The `{{` popover / filter match: key or label contains the query. */
export function matchesQuery(v: StudioVariable, q: string): boolean {
  const s = q.trim().toLowerCase();
  return s === '' || v.key.toLowerCase().includes(s) || v.label.toLowerCase().includes(s);
}
