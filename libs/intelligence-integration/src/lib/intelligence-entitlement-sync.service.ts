import { Injectable, Logger } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import { ENTITLEMENT_SYNC_MAX_TENANTS, SOURCE_SYSTEM_ARAMO_ATS, type EntitlementSyncResponse } from '@aramo/intelligence-contracts';

import { IntelligenceClient } from './intelligence-client.js';

// ATI-SEP-1 T8 (ADR-0036 §6) — keeps TI's EntitledTenant table in step with the
// ATS `intelligence` capability (TI's reads and webhook fan-out need an ACTIVE row).
//
//   * best-effort UPSERT — the publisher calls ensureEntitled() before a tenant's
//     first ingest in this process, so a newly granted tenant is active in TI
//     before its first talent arrives;
//   * periodic full REPLACE (the worker, INTELLIGENCE_ENTITLEMENT_SYNC_INTERVAL_MS,
//     default 15 min) — the authoritative reconcile: grants AND revocations.
//
// The capability is granted only at tenant provisioning today (platform-admin
// grantCapabilities; there is no runtime grant / revoke surface for any
// capability), so the REPLACE sync is what carries a revocation (a removed
// TenantEntitlement row) to TI. Never on an ATS request path.

const UPSERT_TTL_MS = 15 * 60_000;

@Injectable()
export class IntelligenceEntitlementSyncService {
  private readonly logger = new Logger('IntelligenceEntitlementSync');
  private readonly upserted = new Map<string, number>();

  constructor(
    private readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
  ) {}

  /** Best-effort UPSERT of one entitled tenant (cached per process for 15 min). Never throws. */
  async ensureEntitled(tenantId: string, nowMs: number = Date.now()): Promise<void> {
    if (!this.client.configured) return;
    const at = this.upserted.get(tenantId);
    if (at !== undefined && nowMs - at < UPSERT_TTL_MS) return;
    try {
      await this.client.syncEntitlements({
        source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
        mode: 'UPSERT',
        tenants: [{ tenant_id: tenantId, active: true }],
      });
      this.upserted.set(tenantId, nowMs);
    } catch (err) {
      this.logger.warn({ event: 'intelligence_entitlement_upsert_failed', tenant_id: tenantId, reason: (err as Error).message });
    }
  }

  /** Full REPLACE: every tenant holding `intelligence` active; every other ATS tenant deactivated in TI. */
  async replaceAll(): Promise<EntitlementSyncResponse | null> {
    if (!this.client.configured) return null;
    const tenants = await this.entitlements.listTenantIdsWithCapability('intelligence');
    if (tenants.length > ENTITLEMENT_SYNC_MAX_TENANTS) {
      // A REPLACE that cannot list every tenant would deactivate the rest — refuse.
      this.logger.error({ event: 'intelligence_entitlement_replace_refused', tenants: tenants.length, max: ENTITLEMENT_SYNC_MAX_TENANTS });
      return null;
    }
    const result = await this.client.syncEntitlements({
      source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
      mode: 'REPLACE',
      tenants: tenants.map((tenant_id) => ({ tenant_id, active: true })),
    });
    const now = Date.now();
    this.upserted.clear();
    for (const t of tenants) this.upserted.set(t, now);
    this.logger.log({ event: 'intelligence_entitlement_replace', tenants: tenants.length, applied: result.applied, deactivated: result.deactivated });
    return result;
  }
}
