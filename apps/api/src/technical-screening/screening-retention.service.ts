import { Injectable, Logger } from '@nestjs/common';
import { TranscriptNormalizationService } from '@aramo/conversation-transcript';
import { TechnicalScreeningRepository } from '@aramo/technical-screening';

// TIP-E2E INC-3 A1-8 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED R-B, Part H) — the
// screening retention rule. No tenant transcript-retention policy authority
// exists today (the §10.3(c) period is an open PO/Legal decision), so the R-B
// default applies: once a session is CONFIRMED or VOIDED,
//   - the screening AI content (question plan, notes, suggestions) is deleted;
//   - every linked transcript's SOURCE and NORMALIZED object-storage artifacts
//     are deleted through the B4 lifecycle (metadata + provenance survive,
//     CI v1.2 §8.2), so a cited excerpt is never reconstructed afterwards.
// Never indefinite, never an invented production period. Idempotent: a re-run
// finds nothing left to delete. Failures are reported, never silently absorbed.

export interface ScreeningRetentionResult {
  ai_content_deleted: number;
  transcripts: Array<{ conversation_transcript_id: string; status: 'deleted' | 'failed' }>;
}

@Injectable()
export class ScreeningRetentionService {
  private readonly logger = new Logger(ScreeningRetentionService.name);

  constructor(
    private readonly repo: TechnicalScreeningRepository,
    private readonly normalization: TranscriptNormalizationService,
  ) {}

  async applyTerminalRetention(tenantId: string, sessionId: string): Promise<ScreeningRetentionResult> {
    const { deleted } = await this.repo.deleteSessionAiContent(tenantId, sessionId);
    const links = await this.repo.listTranscriptLinks(tenantId, sessionId);
    const transcripts: ScreeningRetentionResult['transcripts'] = [];
    for (const link of links) {
      try {
        await this.normalization.deleteNormalizedArtifact(tenantId, link.conversation_transcript_id);
        await this.normalization.deleteSourceArtifact(tenantId, link.conversation_transcript_id);
        transcripts.push({ conversation_transcript_id: link.conversation_transcript_id, status: 'deleted' });
      } catch (err) {
        this.logger.error(
          `screening retention: transcript artifact deletion failed (${err instanceof Error ? err.name : 'unknown'})`,
        );
        transcripts.push({ conversation_transcript_id: link.conversation_transcript_id, status: 'failed' });
      }
    }
    return { ai_content_deleted: deleted, transcripts };
  }
}
