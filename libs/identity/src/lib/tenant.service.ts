import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { TenantDto } from './dto/tenant.dto.js';
import { TenantRepository } from './tenant.repository.js';
import { deriveAllowedDomainOrThrow } from './util/email-domain.js';

// TenantService — at AUTHZ-1, this surface was read-only
// (getTenantsByUser) with the auth-service SessionOrchestrator the only
// consumer of the read path.
//
// AUTHZ-2 (Lead ruling 6): identity owns Tenant, so the create surface
// lives here, app-guarded by `platform:tenant:provision` at the
// apps/platform-admin layer. The cross-schema saga (Cognito ->
// identity-tx -> entitlement-tx) is orchestrated by the platform-admin
// invitation service; this service is the identity-tx for the Tenant
// row + the identity.tenant.created audit. The 13 tenant role catalog
// and the 47 tenant scope catalog are unchanged — provisioning seeds
// only the Tenant row + the entitlement rows (capability presence-as-
// entitled). The Tenant-Owner-first invite is the platform-admin
// service's responsibility (it composes provisionTenant +
// IdentityService.createUserFromInvitation).
@Injectable()
export class TenantService {
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly audit: IdentityAuditService,
  ) {}

  async getTenantsByUser(args: { user_id: string }): Promise<TenantDto[]> {
    return this.tenantRepo.findActiveTenantsForUser(args);
  }

  async findByNameCaseInsensitive(name: string): Promise<TenantDto | null> {
    return this.tenantRepo.findByNameCaseInsensitive(name);
  }

  // AUTHZ-2: the guarded tenant-provisioning surface. Raises
  // TENANT_ALREADY_EXISTS (409) when the name collides case-
  // insensitively. The caller (platform-admin's PlatformInvitationService)
  // is responsible for sequencing Cognito (AdminCreateUser for the
  // Tenant Owner) BEFORE invoking provisionTenant, then for invoking the
  // entitlement-tx after the identity write completes. Soft-disable on
  // entitlement-tx failure (Lead ruling 7) is performed via
  // deactivateTenant below.
  //
  // Domain-Enforcement P1 (the SERVICE-LAYER invariant — the load-bearing
  // placement choice): the reject-personal check + allowed_domain derivation
  // live HERE, not in the platform-admin controller. Every tenant-creation
  // path calls provisionTenant (today: platform-admin; tomorrow: a self-
  // service signup), so placing the invariant where the tenant is BORN means
  // every future caller inherits personal-email rejection + domain-lock with
  // ZERO new validation logic. The owner's (non-personal) email domain
  // BECOMES the tenant's locked allowed_domain.
  async provisionTenant(args: {
    name: string;
    owner_email: string;
    actor_user_id: string;
  }): Promise<TenantDto> {
    const existing = await this.tenantRepo.findByNameCaseInsensitive(args.name);
    if (existing !== null) {
      throw new AramoError(
        'TENANT_ALREADY_EXISTS',
        'A tenant with this name already exists',
        409,
        {
          requestId: 'provision',
          details: { name: args.name, existing_tenant_id: existing.id },
        },
      );
    }

    // Domain-Enforcement P1 — derive + validate the owner's domain (the
    // single-source gate; throws 4xx for an empty/personal/disposable domain).
    // The owner_email is @IsEmail-validated at the platform-admin DTO, but the
    // service stays authoritative so a future caller (self-service signup)
    // inherits the invariant. The surviving domain becomes the tenant's locked
    // allowed_domain (stored normalized).
    const allowed_domain = deriveAllowedDomainOrThrow(
      args.owner_email,
      'provision',
    );

    const tenant_id = uuidv7();
    const tenant = await this.tenantRepo.createTenant({
      id: tenant_id,
      name: args.name,
      allowed_domain,
    });
    await this.audit.writeEvent({
      event_type: 'identity.tenant.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: tenant.id,
      subject_id: tenant.id,
      payload: {
        name: args.name,
        source: 'platform.provision',
        allowed_domain,
      },
    });
    return tenant;
  }

  // AUTHZ-2 (Lead ruling 7): soft-disable on entitlement-tx failure. The
  // identity-tx + Cognito records remain durable; the tenant becomes
  // inert (EntitlementGuard blocks all capability routes, JwtAuthGuard
  // /SessionOrchestrator refuse to issue tokens for an inactive tenant).
  async deactivateTenant(args: {
    tenant_id: string;
    actor_user_id: string;
    reason: string;
  }): Promise<void> {
    await this.tenantRepo.deactivateTenant({ id: args.tenant_id });
    await this.audit.writeEvent({
      event_type: 'identity.tenant.created',
      // Reuse the existing tenant-scoped event_type for the rollback
      // marker (the closed EVENT_TYPES set has no .deactivated entry; a
      // dedicated rollback event_type is a follow-on PR). The payload's
      // `rollback: true` + reason distinguishes this from a creation
      // event for downstream consumers.
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: args.tenant_id,
      payload: { rollback: true, reason: args.reason },
    });
  }
}
