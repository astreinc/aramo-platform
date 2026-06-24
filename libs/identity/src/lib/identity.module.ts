import {
  DynamicModule,
  Module,
  Type,
  type ModuleMetadata,
} from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommonModule } from '@aramo/common';
import { EntitlementModule } from '@aramo/entitlement';
import { MailerModule } from '@aramo/mailer';

import { IdentityCoreModule } from './identity-core.module.js';
// Settings S3a — tenant-user lifecycle (invite + disable).
import {
  StubTenantCognitoAdapter,
  TENANT_COGNITO_PORT,
  type TenantCognitoPort,
} from './tenant-user/tenant-cognito.port.js';
import { TenantUserLifecycleService } from './tenant-user/tenant-user-lifecycle.service.js';
import { TenantUserManagementController } from './tenant-user/tenant-user-management.controller.js';
// Invite-S2 (Pattern-2) — the public acceptance flow's lifecycle service.
import { InvitationLifecycleService } from './tenant-user/invitation-lifecycle.service.js';
// Settings S4 — auditor_with_financials GATE precondition port.
import {
  AUDIT_FINANCIALS_GATE,
  StubAuditFinancialsGateAdapter,
  type AuditFinancialsGate,
} from './tenant-user/audit-financials-gate.port.js';

// Options for IdentityModule.forRoot — the composition-root entry point.
// cognitoAdapter is the live TenantCognitoPort implementation (apps/api's
// AWS-SDK-backed TenantCognitoAdapter). Required: TypeScript rejects
// forRoot({}) at compile time, so a real-adapter omission can never
// silently degrade to the stub.
//
// auditFinancialsGate is the live AuditFinancialsGate implementation
// (apps/api's TenantSettingService-backed AuditFinancialsGateAdapter — the
// Settings S4 / D5 pay-rate-visibility precondition gate). Required for the
// same reason: omission is a compile error, never a silent fallback to the
// throw-on-call stub.
//
// imports threads the module(s) that PROVIDE the bound adapters' own
// dependencies into IdentityModule's dynamic scope. The cognito adapter has a
// no-arg constructor, but AuditFinancialsGateAdapter injects TenantSettingService
// (from @aramo/settings), so apps/api passes [SettingsModule] (which exports it)
// — without it the useClass binding throws UnknownDependenciesException at boot.
// libs/identity stays LEAF (no @aramo/settings edge): the importer threads the
// module through as an opaque ModuleMetadata['imports'] entry; libs/identity
// never names SettingsModule. Optional — dependency-free adapters need no imports.
export interface IdentityModuleOptions {
  cognitoAdapter: Type<TenantCognitoPort>;
  auditFinancialsGate: Type<AuditFinancialsGate>;
  imports?: ModuleMetadata['imports'];
}

// IdentityModule — the apps/api-ONLY tenant-user invite/role surface
// (Auth-Hardening IdentityModule-Split Directive v1.0, Option c).
//
// This module hosts ONLY the invite-saga surface: the two ports
// (TENANT_COGNITO_PORT, AUDIT_FINANCIALS_GATE), their sole consumer
// (TenantUserLifecycleService), and the route that drives them
// (TenantUserManagementController). Everything else — the shared read services,
// repositories, and the D4a/audit/profile/sites/role-catalog tenant surfaces —
// lives in IdentityCoreModule, which this module imports (and re-exports so
// apps/api keeps a single `@aramo/identity` import for both surfaces).
//
// THE COLLISION, REMOVED. Before the split, the @Module decorator that bound
// the stub ports + the lifecycle consumer was shared by BOTH a static
// `imports: [IdentityModule]` (keyed by the class) and the dynamic
// `IdentityModule.forRoot(...)` (keyed by the returned object) — two instances
// under NestJS 11's ByReferenceModuleOpaqueKeyFactory. The static (stub-bound)
// instance, pulled in earliest by CompanyModule, won the invite route and
// resolved StubTenantCognitoAdapter (→ COGNITO_PROVISION_FAILED). Now NOTHING
// imports IdentityModule statically — the five former static importers import
// IdentityCoreModule instead — so apps/api's forRoot is the SOLE registration:
// exactly one instance, the real adapters authoritative, last-wins true within
// the single scope.
//
// The stub defaults below remain as a fail-LOUD guard: if some future module
// ever imports IdentityModule statically (re-introducing a second instance), it
// resolves the throw-on-call stubs rather than silently fake-succeeding. With
// the current wiring they are never constructed in the apps/api graph.
@Module({
  imports: [
    IdentityCoreModule,
    // The invite controller's guard chain (@UseGuards(JwtAuthGuard,
    // EntitlementGuard, RolesGuard)) resolves these here.
    AuthModule,
    AuthorizationModule,
    CommonModule,
    EntitlementModule,
    // Invite-S2 — the S1 generic mailer. A CLEAN STATIC LEAF (no forRoot) so
    // MAILER_PORT binds once and resolves in this module's scope for both
    // lifecycle services. MailerModule enters ONLY apps/api's graph (via this
    // slim IdentityModule, imported only by apps/api's forRoot) — the five
    // IdentityCoreModule importers never see it. Its MAILER_PORT factory reads
    // MAILER_PROVIDER at module-binding time (fail-loud on unset); the test
    // env defaults it to 'stub' in vitest.shared.js.
    MailerModule,
  ],
  controllers: [
    // Settings S3a — tenant-tier user lifecycle endpoints (invite + disable +
    // role-assign). The Cognito cross-store reach is via TENANT_COGNITO_PORT;
    // the financials-gate precondition via AUDIT_FINANCIALS_GATE.
    TenantUserManagementController,
  ],
  providers: [
    TenantUserLifecycleService,
    // Invite-S2 — the public acceptance flow's lifecycle service (exported
    // below so apps/api's PublicInvitationController can inject it).
    InvitationLifecycleService,
    // The plain-import defaults: throw-on-call stubs. apps/api's forRoot
    // appends same-token providers (real adapters) to THIS module's own scope
    // (last-wins). Since nothing imports IdentityModule statically anymore, the
    // stubs are never reached in the apps/api graph — they only guard against a
    // future accidental static import (fail-loud, never fake-success).
    {
      provide: TENANT_COGNITO_PORT,
      useClass: StubTenantCognitoAdapter,
    },
    {
      provide: AUDIT_FINANCIALS_GATE,
      useClass: StubAuditFinancialsGateAdapter,
    },
  ],
  exports: [
    // Re-export the shared surface so apps/api (the sole importer, via forRoot)
    // keeps injecting IdentityService / IdentityAuditService / TeamRepository /
    // etc. from a single `@aramo/identity` import.
    IdentityCoreModule,
    TenantUserLifecycleService,
    // Invite-S2 — exported so apps/api's public (un-guarded) acceptance
    // controller can inject it.
    InvitationLifecycleService,
  ],
})
export class IdentityModule {
  // forRoot is for the composition root that OWNS the real adapters —
  // apps/api ONLY. It returns a DynamicModule that NestJS MERGES with the
  // @Module decorator above: the dynamic providers for TENANT_COGNITO_PORT
  // and AUDIT_FINANCIALS_GATE are appended to this module's own providers,
  // so they shadow the stub defaults (last-wins within a single module's
  // scope) — and bind IN IdentityModule's scope, where TenantUserLifecycleService
  // (a provider of this module) resolves BOTH tokens (adjacent constructor
  // params). cognitoAdapter and auditFinancialsGate are REQUIRED — omission is
  // a compile error, never a silent runtime fallback.
  //
  // Post-split, IdentityModule is imported ONLY here (apps/api), so this
  // dynamic module is the only IdentityModule instance — the multi-instance
  // stub collision is structurally impossible.
  static forRoot(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: TENANT_COGNITO_PORT,
          useClass: options.cognitoAdapter,
        },
        {
          provide: AUDIT_FINANCIALS_GATE,
          useClass: options.auditFinancialsGate,
        },
      ],
    };
  }
}
