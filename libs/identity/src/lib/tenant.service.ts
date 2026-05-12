import { Injectable } from '@nestjs/common';

import type { TenantDto } from './dto/tenant.dto.js';
import { TenantRepository } from './tenant.repository.js';

// TenantService — per directive §7, returns Tenants the user has an active
// membership in, filtering both inactive memberships and inactive tenants.
@Injectable()
export class TenantService {
  constructor(private readonly tenantRepo: TenantRepository) {}

  async getTenantsByUser(args: { user_id: string }): Promise<TenantDto[]> {
    return this.tenantRepo.findActiveTenantsForUser(args);
  }
}
