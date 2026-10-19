import { Injectable, Logger } from '@nestjs/common';
import { IdentityRepository, IdentityService } from '@aramo/identity';

// Aramo Sign launch — governed subscribing-owner activation (Final Implementation
// Authorization: provisioning integrity + commercial authority).
//
// Sender privilege never comes from account creation alone. When a paid
// subscription opens, the user who started that checkout (recorded server-side
// in the CheckoutIntent, never asserted by a browser) receives `esign_owner` —
// and only if they are STILL an active member of that tenant holding its
// organization authority (org_admin or tenant_owner). Anyone else is left as is
// and the outcome is reported, never silently widened. Idempotent.

export const SUBSCRIBING_OWNER_ROLE = 'esign_owner';
const ORGANIZATION_AUTHORITY_ROLES = new Set(['org_admin', 'tenant_owner']);

export type OwnerActivationOutcome = 'GRANTED' | 'ALREADY' | 'NOT_MEMBER' | 'NOT_ORG_AUTHORITY' | 'FAILED';

@Injectable()
export class EsignOwnerActivationService {
  private readonly log = new Logger(EsignOwnerActivationService.name);

  constructor(
    private readonly repo: IdentityRepository,
    private readonly identity: IdentityService,
  ) {}

  async activate(tenant_id: string, user_id: string, request_id: string): Promise<OwnerActivationOutcome> {
    try {
      const membership = await this.repo.findMembership({ user_id, tenant_id });
      if (membership === null || membership.is_active === false) return 'NOT_MEMBER';
      const user = await this.repo.findUserById(user_id);
      if (user === null || user.is_active === false) return 'NOT_MEMBER';
      const keys = await this.identity.findRoleKeysForMembership(membership.id);
      if (keys.includes(SUBSCRIBING_OWNER_ROLE)) return 'ALREADY';
      if (!keys.some((k) => ORGANIZATION_AUTHORITY_ROLES.has(k))) return 'NOT_ORG_AUTHORITY';
      const role_keys = [...keys, SUBSCRIBING_OWNER_ROLE];
      const role_ids = await this.identity.resolveRoleIdsByKeys(role_keys);
      // replaceMembershipRoles runs the Sign-partition assignability gate (tenant
      // must hold `esign`) and bumps the principal's authz_version.
      await this.identity.replaceMembershipRoles({ membership_id: membership.id, tenant_id, role_keys, role_ids, request_id });
      this.log.log(`granted ${SUBSCRIBING_OWNER_ROLE} to the subscribing owner (tenant ${tenant_id})`);
      return 'GRANTED';
    } catch (err) {
      this.log.error(`subscribing-owner activation failed (tenant ${tenant_id}): ${(err as Error).message}`);
      return 'FAILED';
    }
  }
}
