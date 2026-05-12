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
}
