import { Injectable, Logger } from '@nestjs/common';

// Settings S4 — AuditFinancialsGate.
//
// The cross-lib boundary between the tenant-user role-assign saga
// (libs/identity) and the tenant-settings read seam (libs/settings). The
// port lives here as a TS interface + DI token so libs/identity does NOT
// import @aramo/settings — the leaf-lib invariant on libs/settings stays
// intact AND libs/identity's lean import set is preserved (no new lib
// edge; matches the directive's "no new edge" invariant).
//
// The pattern MIRRORS TenantCognitoPort verbatim — interface + symbol
// token + Stub default; apps/api binds the live adapter at AppModule
// wiring (the adapter reads via TenantSettingService).
//
// The single method `isFinancialsAuditEnabled(tenant_id)` reads ONE
// closed-set known-key: `audit.financials_enabled` (boolean, default
// false). The narrow shape is deliberate — the port is keyed to the S4
// GATE, not a general TenantSettingService re-export. A future settings-
// driven gate (S6+) would either reuse this port (if the answer remains
// a single boolean) or declare its OWN narrow port (preferred — keeps
// each gate's read surface minimal + auditable in isolation).

export interface AuditFinancialsGate {
  // Returns the tenant's current `audit.financials_enabled` value.
  // FALSE on a no-row tenant (the S4 PRECEDENT: tenants opt-in to the
  // financial-auditor grant; default-off is the safe surface). Throws
  // bubble up to the saga, which surfaces them as 5xx — the GATE check
  // must be reliable; a settings-read failure must NOT silently allow
  // the grant.
  isFinancialsAuditEnabled(tenantId: string): Promise<boolean>;
}

export const AUDIT_FINANCIALS_GATE = Symbol('AUDIT_FINANCIALS_GATE');

// Default stub adapter — registered in IdentityModule so the lifecycle
// service can be constructed in the dependency graph. Throws at first
// call; apps/api overrides this with the TenantSettingService-backed
// adapter at AppModule wiring. Tests inject a mock directly. The throw
// text names the missing wire so a forgotten override is loud, not
// silent — same precedent as StubTenantCognitoAdapter (S3a).
@Injectable()
export class StubAuditFinancialsGateAdapter implements AuditFinancialsGate {
  private readonly logger = new Logger(StubAuditFinancialsGateAdapter.name);

  async isFinancialsAuditEnabled(): Promise<boolean> {
    const msg =
      `AuditFinancialsGate.isFinancialsAuditEnabled called on the default ` +
      `stub adapter. Bind a real adapter (e.g. apps/api's ` +
      `AuditFinancialsGateAdapter, backed by TenantSettingService) to the ` +
      `AUDIT_FINANCIALS_GATE token in the consuming module.`;
    this.logger.error(msg);
    throw new Error(msg);
  }
}
