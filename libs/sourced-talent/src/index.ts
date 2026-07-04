// Public surface of @aramo/sourced-talent (Fix-Slice-1). The L1 per-arrival
// staging substrate of the Pipeline (CIP) — the landing table a sourced
// arrival accrues evidence against before promotion to a TalentRecord
// (Talent-Lifecycle & Trust Architecture Spec v1.1 §2 L1 / §3.1).
//
// SCOPE: substrate only. The Sourcing Service that writes arrivals (ADR-0019)
// and the promotion/resolver wiring (fix-slice-2) live downstream.

export { SourcedTalentModule } from './lib/sourced-talent.module.js';
export { SourcedTalentRepository } from './lib/sourced-talent.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  SourcedTalentRow,
  RecordArrivalInput,
} from './lib/sourced-talent.repository.js';
