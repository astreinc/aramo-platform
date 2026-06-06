import { Injectable } from '@nestjs/common';
import type { AuditFinancialsGate } from '@aramo/identity';
import { TenantSettingService } from '@aramo/settings';

// Settings S4 — AuditFinancialsGateAdapter (live implementation of the
// AUDIT_FINANCIALS_GATE declared in libs/identity).
//
// Reads the tenant's `audit.financials_enabled` KNOWN_SETTING via the
// existing S2 TenantSettingService.get<K> seam — NO new DB query path,
// NO duplicate registry knowledge. The adapter is the only place where
// libs/identity (via its port) and libs/settings (via the service)
// meet; both libs stay leaf-clean (libs/identity has no @aramo/settings
// import; libs/settings has no @aramo/identity import). Mirrors the
// TenantCognitoAdapter precedent that bridges libs/identity + AWS-SDK.
//
// Default fallback: TenantSettingService.get returns the KNOWN_SETTINGS
// default (`false`) when no row exists for the tenant — the S4
// PRECEDENT: tenants opt-in to the financial-auditor grant. The
// adapter does not re-implement the default; it relies on the
// service's default-fallback contract.
@Injectable()
export class AuditFinancialsGateAdapter implements AuditFinancialsGate {
  constructor(private readonly tenantSettings: TenantSettingService) {}

  async isFinancialsAuditEnabled(tenantId: string): Promise<boolean> {
    return this.tenantSettings.get(tenantId, 'audit.financials_enabled');
  }
}
