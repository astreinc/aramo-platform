import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { CompanyController } from './company.controller.js';
import { CompanyDepartmentRepository } from './company-department.repository.js';
import { CompanyRepository } from './company.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// CompanyModule — PR-A2 Gate 5 ATS Batch 1.
//
// Leaf import set (lint:nx-boundaries — no domain back-edges):
//   - AuthModule        → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule → EntitlementGuard
// No imports of any other domain lib (no contact dep — billing_contact_id
// is a logical UUID resolved at read time, not a typed cross-lib link).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [CompanyController],
  providers: [PrismaService, CompanyRepository, CompanyDepartmentRepository],
  exports: [CompanyRepository, CompanyDepartmentRepository],
})
export class CompanyModule {}
