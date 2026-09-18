import { describe, expect, it } from 'vitest';

import {
  SkillReviewQueueService,
  ReviewQueueCursorError,
} from '../skill-governance/skill-review-queue.service.js';

// SKILL-TAX-1F-B2 — the platform review-queue union is pure once each domain's
// unresolved aggregates (with INTERNAL tenant membership) are supplied. These specs
// prove the ratified contract with in-memory fakes: (1) surfaces are merged by the
// AUTHORITATIVE normalized form across both domains; (2) tenant_count is the EXACT
// distinct union (a tenant present in both domains for one surface counts ONCE) and
// NO tenant id ever appears in a row; (3) keyset order occurrence_count DESC,
// surface_form ASC with an opaque cursor that continues correctly and is REJECTED
// when replayed under different filters.

type Agg = { surface_form: string; occurrence_count: number; tenant_ids: string[] };

function fakeRepo(rows: Agg[]) {
  return {
    listUnresolvedSurfaceAggregates: async (_args: { scanLimit: number; surfaceSearch?: string | null }) => rows,
  };
}

function svc(talent: Agg[], requisition: Agg[]): SkillReviewQueueService {
  return new SkillReviewQueueService(
    fakeRepo(talent) as never,
    fakeRepo(requisition) as never,
  );
}

describe('SkillReviewQueueService', () => {
  it('merges by normalized surface across domains; unions tenants; counts-only (no tenant ids leak)', async () => {
    // "Kubernetes" (talent, tenant A×2 rows→count via occurrence) + "kubernetes"
    // (requisition, tenant B) normalize to the same key.
    const service = svc(
      [{ surface_form: 'Kubernetes', occurrence_count: 3, tenant_ids: ['A', 'B'] }],
      [{ surface_form: 'kubernetes', occurrence_count: 2, tenant_ids: ['B', 'C'] }],
    );
    const page = await service.list({ limit: 50 });
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0]!;
    expect(row.surface_form).toBe('kubernetes');
    expect(row.occurrence_count).toBe(5); // 3 + 2
    expect(row.tenant_count).toBe(3); // {A,B} ∪ {B,C} = {A,B,C}
    // Counts-only: the row carries no tenant identifiers.
    expect(row).not.toHaveProperty('tenant_ids');
    expect(row).not.toHaveProperty('tenant_id');
    expect(Object.keys(row).sort()).toEqual(['occurrence_count', 'surface_form', 'tenant_count']);
  });

  it('orders by occurrence_count DESC, surface_form ASC and paginates by the opaque keyset cursor', async () => {
    const service = svc(
      [
        { surface_form: 'alpha', occurrence_count: 5, tenant_ids: ['A'] },
        { surface_form: 'bravo', occurrence_count: 5, tenant_ids: ['A'] },
        { surface_form: 'charlie', occurrence_count: 2, tenant_ids: ['A'] },
      ],
      [],
    );
    const page1 = await service.list({ limit: 2 });
    expect(page1.rows.map((r) => r.surface_form)).toEqual(['alpha', 'bravo']); // 5/alpha, 5/bravo
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await service.list({ limit: 2, cursor: page1.next_cursor! });
    expect(page2.rows.map((r) => r.surface_form)).toEqual(['charlie']);
    expect(page2.next_cursor).toBeNull();
  });

  it('applies min_occurrence AFTER the cross-domain merge', async () => {
    const service = svc(
      [{ surface_form: 'react', occurrence_count: 1, tenant_ids: ['A'] }],
      [{ surface_form: 'React', occurrence_count: 1, tenant_ids: ['B'] }],
    );
    // Neither domain alone reaches 2, but the merged occurrence is 2 → included.
    const included = await service.list({ limit: 50, minOccurrence: 2 });
    expect(included.rows.map((r) => r.surface_form)).toEqual(['react']);
    // Raising the floor past the merged total excludes it.
    const excluded = await service.list({ limit: 50, minOccurrence: 3 });
    expect(excluded.rows).toHaveLength(0);
  });

  it('source_domain=talent restricts the queue to the talent domain', async () => {
    const service = svc(
      [{ surface_form: 'go', occurrence_count: 4, tenant_ids: ['A'] }],
      [{ surface_form: 'rust', occurrence_count: 9, tenant_ids: ['B'] }],
    );
    const page = await service.list({ limit: 50, sourceDomain: 'talent' });
    expect(page.rows.map((r) => r.surface_form)).toEqual(['go']);
  });

  it('rejects a cursor replayed under a different filter set (fingerprint mismatch)', async () => {
    const service = svc(
      [
        { surface_form: 'alpha', occurrence_count: 5, tenant_ids: ['A'] },
        { surface_form: 'bravo', occurrence_count: 3, tenant_ids: ['A'] },
      ],
      [],
    );
    const page1 = await service.list({ limit: 1 });
    expect(page1.next_cursor).not.toBeNull();
    // Same cursor, but now with a surface_search filter → the pinned fingerprint differs.
    await expect(
      service.list({ limit: 1, cursor: page1.next_cursor!, surfaceSearch: 'alp' }),
    ).rejects.toBeInstanceOf(ReviewQueueCursorError);
  });

  it('rejects a structurally malformed cursor', async () => {
    const service = svc([], []);
    await expect(service.list({ limit: 10, cursor: 'not-a-valid-cursor' })).rejects.toBeInstanceOf(
      ReviewQueueCursorError,
    );
  });
});
