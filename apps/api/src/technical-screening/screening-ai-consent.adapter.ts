import { Injectable } from '@nestjs/common';
import { ConsentService } from '@aramo/consent';
import type { ScreeningAiConsentPort } from '@aramo/technical-screening';

// TIP-E2E INC-3 A1-3 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED R-A, §5) — the existing
// `ai_processing` consent operation evaluated against the canonical Consent
// authority. No new consent operation; anything but an explicit `allowed` is a
// refusal (fail closed). General profile access never implies model processing.
@Injectable()
export class ScreeningAiConsentAdapter implements ScreeningAiConsentPort {
  constructor(private readonly consent: ConsentService) {}

  async isAiProcessingAllowed(tenantId: string, talentRecordId: string): Promise<boolean> {
    return this.isOperationAllowed(tenantId, talentRecordId, 'ai_processing');
  }

  // INC-3 A1 §5 — `recording` and `transcription` are each separately required
  // for the Teams paths, evaluated the same fail-closed way.
  async isOperationAllowed(
    tenantId: string,
    talentRecordId: string,
    operation: 'ai_processing' | 'recording' | 'transcription',
  ): Promise<boolean> {
    try {
      const decision = await this.consent.checkOperationForService({
        tenant_id: tenantId,
        talent_record_id: talentRecordId,
        operation,
      });
      return decision.result === 'allowed';
    } catch {
      return false;
    }
  }
}
