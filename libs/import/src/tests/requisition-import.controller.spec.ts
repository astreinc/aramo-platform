import { describe, expect, it, vi } from 'vitest';

import { RequisitionImportController } from '../lib/requisition-import.controller.js';
import { CANONICAL_REQUISITION_IMPORT_KEYS } from '../lib/dto/canonical-requisition-import.dto.js';
import type { RunRequisitionImportRequestDto } from '../lib/dto/canonical-requisition-import.dto.js';

// T8-P2 — controller security + envelope validation (§20). The scope/tenant/site
// axes are enforced by the reused guard stack (JwtAuthGuard + EntitlementGuard +
// RolesGuard + @RequireCapability('ats') + @RequireScopes(...)), identical to
// ImportController; this spec covers the controller's OWN logic: envelope
// validation, tenant-from-AuthContext (never body), and no credential surface.

const AUTH = {
  tenant_id: '01900000-0000-7000-8000-0000000000a1',
  sub: '01900000-0000-7000-8000-0000000000b1',
  scopes: ['requisition:import:write'],
} as never;

function make() {
  const runCanonicalRequisitionImport = vi.fn(async () => ({ id: 'batch-1' }) as never);
  const service = { runCanonicalRequisitionImport } as never;
  return { controller: new RequisitionImportController(service), runCanonicalRequisitionImport };
}

function goodBody(overrides: Partial<RunRequisitionImportRequestDto> = {}): RunRequisitionImportRequestDto {
  return {
    source_label: 'vms',
    records: [{ source_system: 'fieldglass', external_req_id: 'R1', title: 't', openings: 1, company_id: '01900000-0000-7000-8000-0000000000c1' }],
    ...overrides,
  };
}

async function expect400(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect((e as { code?: string; statusCode?: number }).code).toBe('VALIDATION_ERROR');
    expect((e as { statusCode?: number }).statusCode).toBe(400);
    return;
  }
  throw new Error('expected VALIDATION_ERROR (400)');
}

describe('RequisitionImportController — envelope validation (§20)', () => {
  it('rejects a missing/blank source_label', async () => {
    const { controller } = make();
    await expect400(() => controller.run(AUTH, goodBody({ source_label: '  ' }), 'r'));
  });
  it('rejects an empty or non-array records', async () => {
    const { controller } = make();
    await expect400(() => controller.run(AUTH, goodBody({ records: [] }), 'r'));
    await expect400(() => controller.run(AUTH, { source_label: 'x', records: 'nope' } as never, 'r'));
  });
  it('rejects a non-object status_mapping', async () => {
    const { controller } = make();
    await expect400(() => controller.run(AUTH, goodBody({ status_mapping: ['a'] as never }), 'r'));
  });
});

describe('RequisitionImportController — tenant safety (§20)', () => {
  it('derives tenant_id + actor from AuthContext, never the body', async () => {
    const { controller, runCanonicalRequisitionImport } = make();
    // A hostile body attempts to smuggle a different tenant_id.
    const hostile = { ...goodBody(), tenant_id: 'attacker-tenant', imported_by_id: 'attacker' } as never;
    await controller.run(AUTH, hostile, 'r');
    const passed = runCanonicalRequisitionImport.mock.calls[0]?.[0] as { tenant_id: string; imported_by_id: string };
    expect(passed.tenant_id).toBe(AUTH.tenant_id);
    expect(passed.imported_by_id).toBe(AUTH.sub);
    expect(passed.tenant_id).not.toBe('attacker-tenant');
  });
});

describe('RequisitionImportController — no credential surface (§20)', () => {
  it('the canonical contract models no credential/secret/token field', () => {
    const forbidden = ['secret', 'token', 'password', 'credential', 'api_key', 'apikey', 'client_secret', 'access_token', 'refresh_token'];
    for (const key of CANONICAL_REQUISITION_IMPORT_KEYS) {
      for (const bad of forbidden) {
        expect(key.toLowerCase()).not.toContain(bad);
      }
    }
  });
});
