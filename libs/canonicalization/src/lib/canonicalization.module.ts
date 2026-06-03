import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { IngestionModule } from '@aramo/ingestion';
import { TalentModule } from '@aramo/talent';
import { TalentEvidenceModule } from '@aramo/talent-evidence';

import { CanonicalizationOutboxRepository } from './canonicalization-outbox.repository.js';
import { CanonicalizationRepository } from './canonicalization.repository.js';
import { CanonicalizationService } from './canonicalization.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// T2-2a — libs/canonicalization module. Per Directive §3:
//
//   - New leaf lib in the consumer direction; imports IngestionModule +
//     TalentModule + TalentEvidenceModule (forward edges, no cycle —
//     lint:nx-boundaries enforces). The imports establish the module-graph
//     edges that match the Prisma-schema follower direction: this lib
//     READS the talent / talent_evidence / ingestion schemas via its
//     OWN multi-schema Prisma client (Option A) — the imported modules
//     guarantee the source-of-truth schemas exist at runtime and that
//     the module-graph dependency is the right way around (no
//     ingestion → canonicalization, no talent → canonicalization,
//     no talent_evidence → canonicalization edges).
//
//   - Service-only at T2-2a (no controller / no HTTP route). The PR-10
//     precedent (a service with no controller). T2-3's
//     ingestion → canonicalization trigger calls CanonicalizationService
//     directly via DI; no HTTP surface is required.
//
//   - Exports: CanonicalizationService (the public canonicalize() entry
//     point) + CanonicalizationOutboxRepository (consumed by
//     libs/outbox-publisher at T2-2b for the 4th-schema drain — the
//     consent + submittal precedent: the per-schema OutboxRepository is
//     exported by the owning module and injected into the publisher).
//
//   - Providers: PrismaService (the multi-schema canonicalization client),
//     CanonicalizationRepository (the atomic orchestrator),
//     CanonicalizationService (thin pass-through), and the Style A
//     'CanonicalizationRepositoryLogger' factory token mirroring the
//     SubmittalRepository / EngagementRepository logger-DI pattern.
@Module({
  imports: [CommonModule, IngestionModule, TalentModule, TalentEvidenceModule],
  providers: [
    PrismaService,
    CanonicalizationRepository,
    CanonicalizationService,
    CanonicalizationOutboxRepository,
    {
      provide: 'CanonicalizationRepositoryLogger',
      useFactory: () => createAramoLogger(CanonicalizationRepository.name),
    },
  ],
  exports: [CanonicalizationService, CanonicalizationOutboxRepository],
})
export class CanonicalizationModule {}
