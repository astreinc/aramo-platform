import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentEducationRepository } from './talent-education.repository.js';
import { TalentEvidenceRepository } from './talent-evidence.repository.js';

// libs/talent-evidence module — M3 PR-5 Talent-evidence entity foundation
// (directive §4). Wires the talent-evidence-owned PrismaService and the
// TalentEvidenceRepository that creates / reads the 7 Group 2 §2.2
// entities required by EvidenceReference. Follows the PR-1 / PR-4
// entity-foundation pattern verbatim.
//
// PR-5 adds no controllers, no HTTP endpoints, no Pact surface. Out of
// scope per directive §5: TalentSelectionEvent (deferred to M5), the
// §14.4 sensitive-field treatment for TalentWorkAuthorization (deferred
// to follow-up F16), SkillTaxonomy / ingestion-source foundations
// (forward-reference UUIDs only), any FK constraint, any controller /
// endpoint / OpenAPI path, EvidenceReference emission/resolution
// (PR-6), and any change to libs/examination or libs/matching.
//
// ATS-QA-1 I-4 — TalentEducationRepository: the read and recruiter-edit lineage
// for TalentEducationEntry (retire, never overwrite).
@Module({
  providers: [PrismaService, TalentEvidenceRepository, TalentEducationRepository],
  exports: [TalentEvidenceRepository, TalentEducationRepository],
})
export class TalentEvidenceModule {}
