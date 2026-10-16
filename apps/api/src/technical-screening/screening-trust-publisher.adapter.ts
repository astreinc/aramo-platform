import { Injectable } from '@nestjs/common';
import { TalentTrustService } from '@aramo/talent-trust';
import type {
  ScreeningEvidencePublisher,
  ScreeningEvidencePublishInput,
} from '@aramo/technical-screening';

// TIP-E2E INC-3 — the apps/api binding of SCREENING_EVIDENCE_PUBLISHER
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §3/§7). Screening never writes Talent Trust
// directly: this adapter forwards the PINNED intent to Talent Trust's in-process
// writer (Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED §3), which derives class/method from
// basis, writes through the G1 atomic insert and compares a replay. A conflicting
// replay propagates as IDEMPOTENCY_KEY_CONFLICT, which the domain records as a
// terminal CONFLICT; any other error is a transient failure (intent stays PENDING).
@Injectable()
export class ScreeningTrustPublisherAdapter implements ScreeningEvidencePublisher {
  constructor(private readonly trust: TalentTrustService) {}

  async publish(input: ScreeningEvidencePublishInput): Promise<{ written: boolean }> {
    const res = await this.trust.recordScreeningFindingIfAbsent({
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      evidence_id: input.evidence_id,
      assertion_payload: input.assertion_payload,
      collected_at: input.collected_at,
    });
    return { written: res.written };
  }
}
