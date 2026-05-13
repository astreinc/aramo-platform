import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { IdentityAuditRepository } from './audit/identity-audit.repository.js';
import { IdentityAuditService } from './audit/identity-audit.service.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RoleRepository } from './role.repository.js';
import { RoleService } from './role.service.js';
import { TenantRepository } from './tenant.repository.js';
import { TenantService } from './tenant.service.js';

// Per directive §3 dependency direction: libs/auth/ may consume @aramo/identity
// types, but libs/identity/ does not import @aramo/auth. CommonModule is fine
// (AramoError and shared utilities sit there).
//
// PR-8.0a-Reground §7 amendment: IdentityAuditService is added to providers
// and exports (services are the public surface; IdentityAuditRepository
// remains internal).
@Module({
  imports: [CommonModule],
  providers: [
    PrismaService,
    IdentityRepository,
    TenantRepository,
    RoleRepository,
    IdentityAuditRepository,
    IdentityAuditService,
    IdentityService,
    TenantService,
    RoleService,
  ],
  exports: [IdentityService, TenantService, RoleService, IdentityAuditService],
})
export class IdentityModule {}
