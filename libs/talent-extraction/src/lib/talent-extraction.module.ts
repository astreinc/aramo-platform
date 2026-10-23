import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { TalentEvidenceModule } from '@aramo/talent-evidence';

import { TalentExtractionService } from './talent-extraction.service.js';

// Gate-1 G1-A — TalentExtractionModule.
//
// The 3rd declared @aramo/ai-draft consumer (ADR-0015 v1.3): it uses
// AiDraftService.generateDraft to STRUCTURE declared resume/skill text, then
// persists `declared` evidence via TalentEvidenceRepository. This lib is
// DELIBERATELY ungated (no no-llm-boundary.spec.ts) — it is a permitted LLM
// consumer. The gated libs (matching / examination / resume-parse / import)
// keep their boundary specs; scoring stays deterministic + LLM-free.
//
// ATI-SEP-1 A1 — the TR-4 B2 edge talent-extraction → talent-trust lib is
// REMOVED: this lib (scope:ats) persists ATS typed rows only. The typed-row →
// ledger projection lives in the TEMPORARY apps/api LegacyTrustProjectionService
// (deleted at T10), reached only from non-create callers (examine, backfill).
@Module({
  imports: [AiDraftModule, TalentEvidenceModule],
  providers: [TalentExtractionService],
  exports: [TalentExtractionService],
})
export class TalentExtractionModule {}
