import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityCoreModule } from '@aramo/identity';

import { AddressLookupController } from './address-lookup.controller.js';
import { AddressLookupService } from './address-lookup.service.js';
import { CompanyController } from './company.controller.js';
import { CompanyDepartmentRepository } from './company-department.repository.js';
import { CompanyRepository } from './company.repository.js';
import { D4aCompanyController } from './d4a.controller.js';
import { D4aCompanyService } from './d4a.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { TeamClientOwnershipRepository } from './team-client-ownership.repository.js';
import { UserClientAssignmentRepository } from './user-client-assignment.repository.js';

// CompanyModule — PR-A2 Gate 5 ATS Batch 1; AUTHZ-D4a extends with the
// direct-assignment + team-client-ownership joins + their mechanism
// controller.
//
// Import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - IdentityCoreModule  → IdentityAuditService (AUTHZ-D4a). Audit events
//     for company-side D4a writes (user_client_assignment,
//     team.client_ownership) are emitted to identity's closed EVENT_TYPES
//     set; the cross-lib audit emission is the only acceptable path under
//     the schema-per-module / no-cross-schema-FK boundary (Architecture
//     §7.3 + the directive's no-cross-schema-FK halt-condition). No
//     identity imports from libs/company — no cycle.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    IdentityCoreModule,
  ],
  controllers: [
    CompanyController,
    D4aCompanyController,
    // Address-Autocomplete v1.0 — backend proxy for provider address lookup.
    AddressLookupController,
  ],
  providers: [
    PrismaService,
    CompanyRepository,
    CompanyDepartmentRepository,
    // AUTHZ-D4a
    UserClientAssignmentRepository,
    TeamClientOwnershipRepository,
    D4aCompanyService,
    // Address-Autocomplete v1.0 — provider selection + enablement gate.
    AddressLookupService,
  ],
  exports: [
    CompanyRepository,
    CompanyDepartmentRepository,
    // AUTHZ-D4a — exported for cross-lib consumption + direct testing.
    UserClientAssignmentRepository,
    TeamClientOwnershipRepository,
  ],
})
export class CompanyModule {}
