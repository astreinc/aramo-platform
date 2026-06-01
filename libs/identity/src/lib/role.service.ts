import { Injectable } from '@nestjs/common';

import { RoleRepository } from './role.repository.js';

// RoleService — per directive §7, returns deduplicated scope keys the user has
// via active role assignments on an active membership in the given tenant.
@Injectable()
export class RoleService {
  constructor(private readonly roleRepo: RoleRepository) {}

  async getScopesByUserAndTenant(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<string[]> {
    return this.roleRepo.findScopeKeysForUserInTenant(args);
  }

  // PR-A1a Ruling 4 site-aware variant. When site_id is provided, the
  // returned set is the union of tenant-wide and site-X membership
  // scopes. When site_id is undefined, only tenant-wide membership
  // scopes are returned (fail-closed: site authority does not leak to
  // a tenant-wide token).
  async getScopesByUserTenantAndSite(args: {
    user_id: string;
    tenant_id: string;
    site_id?: string;
  }): Promise<string[]> {
    return this.roleRepo.findScopeKeysForUserInTenantAndSite(args);
  }
}
