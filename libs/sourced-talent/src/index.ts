// Public surface of @aramo/sourced-talent (Fix-Slice-1). The L1 per-arrival
// staging substrate of the Pipeline (CIP) — the landing table a sourced
// arrival accrues evidence against before promotion to a TalentRecord
// (Talent-Lifecycle & Trust Architecture Spec v1.1 §2 L1 / §3.1).
//
// ATI-SEP-1 T10 WP2 — scope:ats. The ATS-local sourcing store: written by the
// SRC-1 channel writers + canonicalize, read by the sourcing pool + promotion.

export { SourcedTalentModule } from './lib/sourced-talent.module.js';
export { SourcedTalentRepository } from './lib/sourced-talent.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  SourcedTalentRow,
  RecordArrivalInput,
} from './lib/sourced-talent.repository.js';
