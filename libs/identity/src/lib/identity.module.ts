import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { IdentityAuditRepository } from './audit/identity-audit.repository.js';
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
@Module({
  imports: [CommonModule],
  providers: [
    PrismaService,
    IdentityRepository,
    TenantRepository,
    RoleRepository,
    IdentityAuditRepository,
    IdentityService,
    TenantService,
    RoleService,
  ],
  exports: [IdentityService, TenantService, RoleService],
})
export class IdentityModule {}
