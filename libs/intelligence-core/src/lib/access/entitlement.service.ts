import { Inject, Injectable } from '@nestjs/common';
import {
  ENTITLEMENT_SYNC_MAX_TENANTS,
  SOURCE_SYSTEM_IDS,
  type EntitlementSyncRequest,
  type EntitlementSyncResponse,
} from '@aramo/intelligence-contracts';

import { SourceSystemMismatchError, type IngestPrincipal } from '../ingest/talent-ingest.service.js';
import { INTELLIGENCE_UNIT_OF_WORK, type IntelligenceUnitOfWork } from '../repositories/types.js';

// ATI-SEP-1 T6 — POST /v1/entitlements/sync. TI does not know ATS entitlements:
// the ATS (service client with intelligence:entitlements) tells TI which of its
// tenants hold the `intelligence` capability. The read API and the webhook
// fan-out both require EntitledTenant ACTIVE. A client may sync only its own
// source system.

export class EntitlementSyncInvalidError extends Error {
  constructor(readonly issues: string[]) {
    super('entitlement sync request is invalid');
    this.name = 'EntitlementSyncInvalidError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export function validateEntitlementSync(input: unknown): { ok: true; value: EntitlementSyncRequest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, issues: ['$: must be an object'] };
  const b = input as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['source_system_id', 'mode', 'tenants'].includes(k)) issues.push(`$.${k}: unknown key`);
  if (!(SOURCE_SYSTEM_IDS as readonly unknown[]).includes(b['source_system_id'])) issues.push('$.source_system_id: unknown');
  if (b['mode'] !== 'UPSERT' && b['mode'] !== 'REPLACE') issues.push('$.mode: UPSERT | REPLACE');
  const tenants = b['tenants'];
  if (!Array.isArray(tenants) || tenants.length > ENTITLEMENT_SYNC_MAX_TENANTS) {
    issues.push(`$.tenants: an array of at most ${ENTITLEMENT_SYNC_MAX_TENANTS}`);
  } else {
    const seen = new Set<string>();
    tenants.forEach((t, i) => {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) return issues.push(`$.tenants[${i}]: must be an object`);
      const r = t as Record<string, unknown>;
      for (const k of Object.keys(r)) if (k !== 'tenant_id' && k !== 'active') issues.push(`$.tenants[${i}].${k}: unknown key`);
      if (typeof r['tenant_id'] !== 'string' || !ID_PATTERN.test(r['tenant_id'])) issues.push(`$.tenants[${i}].tenant_id: invalid`);
      else if (seen.has(r['tenant_id'])) issues.push(`$.tenants[${i}].tenant_id: duplicate`);
      else seen.add(r['tenant_id']);
      if (typeof r['active'] !== 'boolean') issues.push(`$.tenants[${i}].active: boolean`);
      return undefined;
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: b as unknown as EntitlementSyncRequest };
}

@Injectable()
export class EntitlementService {
  constructor(@Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork) {}

  async sync(body: unknown, principal: IngestPrincipal): Promise<EntitlementSyncResponse> {
    const v = validateEntitlementSync(body);
    if (!v.ok) throw new EntitlementSyncInvalidError(v.issues);
    const req = v.value;
    if (req.source_system_id !== principal.source_system_id) throw new SourceSystemMismatchError();
    return this.uow.run(
      async (repos) => {
        for (const t of req.tenants) await repos.entitlements.upsert(req.source_system_id, t.tenant_id, t.active);
        const deactivated =
          req.mode === 'REPLACE' ? await repos.entitlements.deactivateAllExcept(req.source_system_id, req.tenants.map((t) => t.tenant_id)) : 0;
        return { applied: req.tenants.length, deactivated };
      },
      { lockKeys: [`entitlements:${req.source_system_id}`] },
    );
  }
}
