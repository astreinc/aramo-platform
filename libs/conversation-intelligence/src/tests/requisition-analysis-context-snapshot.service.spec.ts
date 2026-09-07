import { describe, expect, it, vi } from 'vitest';
import { makeMockLogger } from '@aramo/common';

import { RequisitionAnalysisContextSnapshotService } from '../lib/requisition-analysis-context-snapshot.service.js';
import type { RequisitionAnalysisContextSnapshotRepository } from '../lib/requisition-analysis-context-snapshot.repository.js';
import type { RequisitionAnalysisContextReader } from '../lib/reader/requisition-analysis-context-reader.js';
import { REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION, type RequisitionAnalysisSource } from '../lib/dto/requisition-analysis-context.js';
import type { RequisitionAnalysisContextSnapshotView } from '../lib/dto/requisition-analysis-context-snapshot.view.js';

// CI-B2 unit — capture orchestration semantics with a fake reader + a
// capturing repository. Proves: server-constructed snapshot from the
// source (TEST 5), conceal on absent/cross-tenant (TEST 3/4 at the
// service seam), no-update surface (TEST 2), and no lifecycle side
// effect (TEST 10).

const TENANT = '11111111-1111-7111-8111-111111111111';
const REQ = '22222222-2222-7222-8222-222222222222';

function source(
  overrides: Partial<RequisitionAnalysisSource> = {},
): RequisitionAnalysisSource {
  return {
    tenant_id: TENANT,
    requisition_id: REQ,
    source_requisition_version: 7,
    golden_profile_id: null,
    title: 'Role A',
    job_type: 'contract',
    labor_category: null,
    role_family: null,
    seniority_level: null,
    city: 'Austin',
    state: 'TX',
    postal_code: null,
    work_arrangement: 'remote',
    onsite_days_per_week: null,
    travel_percent: null,
    relocation_offered: false,
    duration_value: null,
    duration_unit: null,
    hours_per_week: null,
    extension_possible: false,
    work_authorization: 'any',
    golden_profile_content: null,
    ...overrides,
  };
}

function makeCapturingRepo(): {
  repo: RequisitionAnalysisContextSnapshotRepository;
  created: unknown[];
} {
  const created: unknown[] = [];
  const repo = {
    async createSnapshot(input: {
      id: string;
      tenant_id: string;
      requisition_id: string;
      source_requisition_version: number;
      golden_profile_id: string | null;
      snapshot_schema_version: string;
      context: unknown;
      captured_at: Date;
    }): Promise<RequisitionAnalysisContextSnapshotView> {
      created.push(input);
      return {
        ...input,
        context: input.context as never,
        created_at: new Date(),
      } as RequisitionAnalysisContextSnapshotView;
    },
    async findById() {
      return null;
    },
    async findByRequisitionId() {
      return [];
    },
  } as unknown as RequisitionAnalysisContextSnapshotRepository;
  return { repo, created };
}

describe('RequisitionAnalysisContextSnapshotService.captureSnapshot', () => {
  it('TEST 5 — server constructs the snapshot from the reader source (version + schema version pinned)', async () => {
    const reader: RequisitionAnalysisContextReader = {
      load: vi.fn(async () => source({ source_requisition_version: 7 })),
    };
    const { repo, created } = makeCapturingRepo();
    const svc = new RequisitionAnalysisContextSnapshotService(
      reader,
      repo,
      makeMockLogger(),
    );

    const view = await svc.captureSnapshot({ tenant_id: TENANT, requisition_id: REQ });

    expect(reader.load).toHaveBeenCalledWith({ tenant_id: TENANT, requisition_id: REQ });
    expect(view.source_requisition_version).toBe(7);
    expect(view.snapshot_schema_version).toBe(REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION);
    expect(view.context.role.title).toBe('Role A');
    // Persisted exactly once.
    expect(created).toHaveLength(1);
  });

  it('TEST 3/4 — conceals an absent / cross-tenant requisition as NOT_FOUND', async () => {
    const reader: RequisitionAnalysisContextReader = {
      // A cross-tenant or missing requisition resolves to null.
      load: vi.fn(async () => null),
    };
    const { repo, created } = makeCapturingRepo();
    const svc = new RequisitionAnalysisContextSnapshotService(
      reader,
      repo,
      makeMockLogger(),
    );

    await expect(
      svc.captureSnapshot({ tenant_id: TENANT, requisition_id: REQ }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // Nothing persisted on the conceal path.
    expect(created).toHaveLength(0);
  });

  it('TEST 2 — exposes no update / patch / delete surface', () => {
    const svc = RequisitionAnalysisContextSnapshotService.prototype as unknown as Record<string, unknown>;
    for (const forbidden of ['update', 'patch', 'edit', 'delete', 'upsert', 'mutate']) {
      expect(svc[forbidden]).toBeUndefined();
    }
    // The only write path is captureSnapshot (create-only).
    expect(typeof svc['captureSnapshot']).toBe('function');
  });

  it('TEST 10 — capture touches only the reader + snapshot repository (no lifecycle side effect)', async () => {
    // The service is constructed with exactly two collaborators: the
    // read port and the snapshot repository. It has no Requisition /
    // Pipeline / Talent / Consent writer, so it structurally cannot
    // mutate a lifecycle. Assert the reader is a pure read (called with
    // identifiers only) and the repository sees a single create.
    const loadCalls: unknown[] = [];
    const reader: RequisitionAnalysisContextReader = {
      load: async (input) => {
        loadCalls.push(input);
        return source();
      },
    };
    const { repo, created } = makeCapturingRepo();
    const svc = new RequisitionAnalysisContextSnapshotService(
      reader,
      repo,
      makeMockLogger(),
    );
    await svc.captureSnapshot({ tenant_id: TENANT, requisition_id: REQ });
    expect(loadCalls).toEqual([{ tenant_id: TENANT, requisition_id: REQ }]);
    expect(created).toHaveLength(1);
  });
});
