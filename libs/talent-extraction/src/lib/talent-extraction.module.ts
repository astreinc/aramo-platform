import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentTrustModule } from '@aramo/talent-trust';

import { TalentExtractionService } from './talent-extraction.service.js';

// Gate-1 G1-A — TalentExtractionModule.
//
// The 3rd declared @aramo/ai-draft consumer (ADR-0015 v1.3): it uses
// AiDraftService.generateDraft to STRUCTURE declared résumé/skill text, then
// persists `declared` evidence via TalentEvidenceRepository. This lib is
// DELIBERATELY ungated (no no-llm-boundary.spec.ts) — it is a permitted LLM
// consumer. The gated libs (matching / examination / resume-parse / import)
// keep their boundary specs; scoring stays deterministic + LLM-free.
//
// TR-4 B2 (DDR §3) — NEW edge talent-extraction → @aramo/talent-trust (I15-legal:
// ATS-side producer → cip trust ledger). The producer dual-writes its typed
// EMPLOYMENT/SKILL claims into the ledger as canonical CLAIMS evidence; no cycle
// (talent-trust replicated deriveSkillId locally in B1 precisely to avoid the
// reverse edge).
@Module({
  imports: [AiDraftModule, TalentEvidenceModule, TalentTrustModule],
  providers: [TalentExtractionService],
  exports: [TalentExtractionService],
})
export class TalentExtractionModule {}
