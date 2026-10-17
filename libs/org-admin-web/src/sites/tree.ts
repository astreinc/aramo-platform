import type { SiteView } from './types';

// Settings Rebuild Directive 4 — branch-hierarchy helpers (pure, testable).

export interface TreeRow {
  readonly site: SiteView;
  readonly depth: number;
}

function childrenByParent(
  sites: readonly SiteView[],
): Map<string | null, SiteView[]> {
  const map = new Map<string | null, SiteView[]>();
  for (const s of sites) {
    const key = s.parent_site_id;
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

// Flattens the flat site list into DFS order with a depth for indentation.
// Roots = sites whose parent is null OR whose parent is not in the set (a
// defensively-handled orphan is surfaced as a root rather than hidden).
export function flattenTree(sites: readonly SiteView[]): TreeRow[] {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const kids = childrenByParent(sites);
  const rows: TreeRow[] = [];
  const seen = new Set<string>();

  const visit = (site: SiteView, depth: number): void => {
    if (seen.has(site.id)) return; // guard against any malformed cycle
    seen.add(site.id);
    rows.push({ site, depth });
    for (const child of kids.get(site.id) ?? []) visit(child, depth + 1);
  };

  const roots = sites
    .filter((s) => s.parent_site_id === null || !byId.has(s.parent_site_id))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const r of roots) visit(r, 0);

  // Any site not reached (e.g. part of a cycle) is appended at depth 0 so the
  // operator can still see and fix it.
  for (const s of sites) if (!seen.has(s.id)) rows.push({ site: s, depth: 0 });
  return rows;
}

// All descendant ids of `id` (excludes `id` itself). Used to keep a branch
// from being reparented under its own subtree in the picker.
export function descendantIds(
  id: string,
  sites: readonly SiteView[],
): string[] {
  const kids = childrenByParent(sites);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (parent: string): void => {
    for (const child of kids.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}
