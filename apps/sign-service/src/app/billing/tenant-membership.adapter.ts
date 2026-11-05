import { Injectable } from '@nestjs/common';
import { IdentityRepository } from '@aramo/identity';
import type { TenantMembershipPort } from '@aramo/subscription';

// Aramo Sign Mobile M-A12 Amendment A1-2 (LOCKED) — in-app purchase needs the tenant to have exactly
// one active member (the purchaser). Read from identity: an active, not deactivated membership whose
// invitation is accepted. A pending invitation is not a member.
@Injectable()
export class TenantMembershipAdapter implements TenantMembershipPort {
  constructor(private readonly identity: IdentityRepository) {}

  async activeMemberCount(tenant_id: string): Promise<number> {
    const users = await this.identity.listTenantUsers(tenant_id);
    return users.filter((u) => u.is_active && u.deactivated_at === null && (u.invite_status === 'ACCEPTED' || u.invite_status === 'ACTIVE')).length;
  }
}
