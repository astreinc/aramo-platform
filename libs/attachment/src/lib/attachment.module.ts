import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentRecordModule } from '@aramo/talent-record';

import { AttachmentController } from './attachment.controller.js';
import { AttachmentRepository } from './attachment.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// AttachmentModule — PR-A4 Gate 5 ATS Batch 3.
//
// Leaf import set (lint:nx-boundaries):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - TalentRecordModule  → TalentRecordRepository (the only owner path
//                           wired at A4 — the directional attachment →
//                           talent-record edge; no cycle, talent-record
//                           does NOT import attachment)
//
// Deliberately NOT imported: @aramo/talent (Core, the tenant-AGNOSTIC
// identity). The Core-Talent adapter is A5.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TalentRecordModule,
  ],
  controllers: [AttachmentController],
  providers: [PrismaService, AttachmentRepository],
  exports: [AttachmentRepository],
})
export class AttachmentModule {}
