import { Injectable, Logger } from '@nestjs/common';

// Settings S3a — TenantCognitoPort.
//
// The cross-store boundary between the lifecycle saga (libs/identity) and the
// AWS Cognito tenant user pool. The port lives here as a TS interface + DI
// token so libs/identity does NOT import @aws-sdk/* (preserves the lib's
// clean import set; the SDK lives at apps/api where the adapter is wired).
//
// At CI / unit-test the lifecycle saga is exercised with a mock implementation
// of this port (the AUTHZ-2 posture for the platform-tier invitation flow).
// Live wiring (AWS-SDK adapter) is a readiness carry — apps/api binds a real
// CognitoIdentityProviderClient-backed implementation at production startup.
//
// Pool routing is the tenant pool (Lead ruling 4 A1 — SEPARATE pools for
// platform vs tenant); the port is tenant-only, no pool parameter. The
// platform-tier flow has its own (existing) CognitoAdminService in apps/
// platform-admin; the two paths do not share a code seam — they share a
// design pattern (Cognito-first invite, identity-first disable + compensation).
//
// Method semantics:
//   - adminCreateUser: RETAINED for the backlogged native-account invite
//     path; NOT called by the Pattern-2 federated invite flow (Invite-S2).
//     The Pattern-2 invite mints no Cognito user at invite time — the sub is
//     minted by Cognito at the invitee's first federated login and linked by
//     the reconcile spine. Kept fully implemented (mirrors adminEnableUser's
//     declared-but-not-currently-called posture) for the future native path.
//   - adminDeleteUser: RETAINED. Was the COMPENSATION for the old Cognito-
//     first invite saga (idempotent; no-throw if missing). The Pattern-2
//     invite has no Cognito leg to roll back, so it is not called by invite
//     either; kept for the native path + symmetry.
//   - adminDisableUser: invoked at the disable saga step 2 (AFTER the
//     identity flip commits); failure triggers the reEnableMembership
//     compensation.
//   - adminEnableUser: NOT used by S3a's saga itself (S3a soft-disable only;
//     a separate re-enable verb is out of scope). Declared here for symmetry
//     so the live AWS-SDK adapter exposes the matching pair, but the lifecycle
//     service does not currently call it.

export interface TenantCognitoPort {
  adminCreateUser(args: {
    email: string;
    display_name?: string | null;
  }): Promise<{ cognito_sub: string }>;

  adminDeleteUser(args: { email: string }): Promise<void>;

  adminDisableUser(args: { email: string }): Promise<void>;

  adminEnableUser(args: { email: string }): Promise<void>;
}

export const TENANT_COGNITO_PORT = Symbol('TENANT_COGNITO_PORT');

// Default stub adapter — registered in IdentityModule so the lifecycle
// service can be constructed in the dependency graph. Throws at first call;
// apps/api overrides this with the AWS-SDK-backed TenantCognitoAdapter at
// AppModule wiring. Tests inject a mock directly. The throw text names the
// missing wire so a forgotten override is loud, not silent.
@Injectable()
export class StubTenantCognitoAdapter implements TenantCognitoPort {
  private readonly logger = new Logger(StubTenantCognitoAdapter.name);

  private fail(method: string): never {
    const msg =
      `TenantCognitoPort.${method} called on the default stub adapter. ` +
      `Bind a real adapter (e.g. apps/api's TenantCognitoAdapter) to the ` +
      `TENANT_COGNITO_PORT token in the consuming module.`;
    this.logger.error(msg);
    throw new Error(msg);
  }

  async adminCreateUser(): Promise<{ cognito_sub: string }> {
    this.fail('adminCreateUser');
  }

  async adminDeleteUser(): Promise<void> {
    this.fail('adminDeleteUser');
  }

  async adminDisableUser(): Promise<void> {
    this.fail('adminDisableUser');
  }

  async adminEnableUser(): Promise<void> {
    this.fail('adminEnableUser');
  }
}
