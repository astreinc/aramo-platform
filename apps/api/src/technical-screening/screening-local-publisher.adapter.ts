import { Injectable } from '@nestjs/common';
import type {
  ScreeningEvidencePublisher,
  ScreeningEvidencePublishInput,
} from '@aramo/technical-screening';

// ATI-SEP-1 T10 WP1 (Addendum A2 F-1 / A3) — the ATS-local binding of
// SCREENING_EVIDENCE_PUBLISHER. Screening stays an ATS capability with ATS-local
// publication state: a confirmed finding's publication intent is marked
// PUBLISHED by the domain (ScreeningEvidencePublication) and nothing is written
// to any trust ledger. The pinned evidence_record_id stays on the publication as
// an inert soft reference (ADD-not-rename). There is no external writer, so a
// publish always succeeds and never reports a conflict; repeated attempts are
// harmless (the domain only attempts PENDING intents).
@Injectable()
export class ScreeningLocalPublisherAdapter implements ScreeningEvidencePublisher {
  async publish(_input: ScreeningEvidencePublishInput): Promise<{ written: boolean }> {
    return { written: true };
  }
}
