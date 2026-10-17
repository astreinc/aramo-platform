import { describe, expect, it } from 'vitest';

import { descendantIds, flattenTree } from './tree';
import type { SiteView } from './types';

function site(over: Partial<SiteView> & { id: string; name: string }): SiteView {
  return {
    is_active: true,
    parent_site_id: null,
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

// hq → [canary (→ docklands), soho]; plus a separate root "berlin".
const SITES: SiteView[] = [
  site({ id: 'hq', name: 'London HQ' }),
  site({ id: 'canary', name: 'Canary Wharf', parent_site_id: 'hq' }),
  site({ id: 'docklands', name: 'Docklands', parent_site_id: 'canary' }),
  site({ id: 'soho', name: 'Soho', parent_site_id: 'hq' }),
  site({ id: 'berlin', name: 'Berlin', parent_site_id: null }),
];

describe('flattenTree', () => {
  it('returns DFS order with depth, roots sorted by name', () => {
    const rows = flattenTree(SITES);
    expect(rows.map((r) => [r.site.id, r.depth])).toEqual([
      ['berlin', 0],
      ['hq', 0],
      ['canary', 1],
      ['docklands', 2],
      ['soho', 1],
    ]);
  });

  it('treats an orphan (parent not in set) as a root', () => {
    const orphan = [site({ id: 'x', name: 'X', parent_site_id: 'missing' })];
    expect(flattenTree(orphan).map((r) => [r.site.id, r.depth])).toEqual([
      ['x', 0],
    ]);
  });
});

describe('descendantIds', () => {
  it('returns the full subtree, excluding the node itself', () => {
    expect(descendantIds('hq', SITES).sort()).toEqual(
      ['canary', 'docklands', 'soho'].sort(),
    );
  });

  it('returns empty for a leaf', () => {
    expect(descendantIds('docklands', SITES)).toEqual([]);
  });
});
