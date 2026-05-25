import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { EngagementModule } from '@aramo/engagement';
import { ExaminationModule } from '@aramo/examination';
import { TalentEvidenceModule } from '@aramo/talent-evidence';

import { EvidenceRepository } from './evidence.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/evidence module — M4 PR-1 entity foundation + M4 PR-2 builder
// + M5 PR-2 cross-schema engagement_event_refs validator.
//
// PR-1 (substrate-only) registered PrismaService + the read-only
// EvidenceRepository. PR-2 extended with the buildPackage write path
// and wired ExaminationModule + TalentEvidenceModule upstream deps.
//
// M5 PR-2 adds EngagementModule (directive §4.9) so the buildPackage
// cross-schema validator can call EngagementEventRepository
// .findByTenantAndId for each engagement_event_refs entry. The
// validator (directive §4.8 / Ruling 7) refuses with
// ENGAGEMENT_EVENT_REF_NOT_FOUND when an entry is not found or is
// found in another tenant.
//
// EvidenceModule is still NOT imported by apps/api at M5 PR-2
// (substrate only; no HTTP route consumer). The submittal-create
// endpoint PR (F33) will add the AppModule import alongside its
// controller.
//
// M4-close HK-PR-4 — AramoLogger provider for EvidenceRepository
// (Style A constructor DI; mirrors libs/submittal PR-9 PoC pattern).
@Module({
  imports: [EngagementModule, ExaminationModule, TalentEvidenceModule],
  providers: [
    PrismaService,
    EvidenceRepository,
    {
      provide: 'EvidenceRepositoryLogger',
      useFactory: () => createAramoLogger(EvidenceRepository.name),
    },
  ],
  exports: [EvidenceRepository],
})
export class EvidenceModule {}
