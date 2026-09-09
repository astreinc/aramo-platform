// CI-B5Z — the production TranscriptConsentGate: the enforcement caller that
// binds the CI acquisition flow to the SOLE Consent authority (libs/consent).
// It resolves the Talent from DURABLE interaction-association truth (never
// inference) and independently checks `recording` AND `transcription` via the
// existing canonical Consent decision logic. It is NOT a consent-granting actor:
// no user session, no second consent store, no consent mutation, read/check only,
// fail-closed. `ai_processing` is NOT checked here (that is B6).

import { Injectable } from '@nestjs/common';
import { CommunicationsRepository } from '@aramo/communications';
import { ConsentService } from '@aramo/consent';

import type { TranscriptConsentGate } from './zoom/zoom-recording-transcript.orchestrator.js';

@Injectable()
export class ConsentTranscriptGate implements TranscriptConsentGate {
  constructor(
    private readonly comms: CommunicationsRepository,
    private readonly consent: ConsentService,
  ) {}

  async evaluate(input: { tenant_id: string; interaction_id: string }): Promise<
    | { allowed: true; consent_decision_ref?: string }
    | { allowed: false; denied_operation: 'recording' | 'transcription' }
    | { allowed: false; talent_resolution: 'none' | 'ambiguous' }
  > {
    // 1. Talent from DURABLE association truth only (subject/talent_record).
    const talentIds = await this.comms.findTalentSubjectIdsForInteraction(
      input.tenant_id,
      input.interaction_id,
    );
    if (talentIds.length === 0) return { allowed: false, talent_resolution: 'none' };
    if (talentIds.length > 1) return { allowed: false, talent_resolution: 'ambiguous' };
    const talentRecordId = talentIds[0] as string;

    // 2. Independent, fail-closed checks against the canonical Consent authority.
    const recording = await this.consent.checkOperationForService({
      tenant_id: input.tenant_id,
      talent_record_id: talentRecordId,
      operation: 'recording',
    });
    if (recording.result !== 'allowed') {
      return { allowed: false, denied_operation: 'recording' };
    }
    const transcription = await this.consent.checkOperationForService({
      tenant_id: input.tenant_id,
      talent_record_id: talentRecordId,
      operation: 'transcription',
    });
    if (transcription.result !== 'allowed') {
      return { allowed: false, denied_operation: 'transcription' };
    }

    return { allowed: true, consent_decision_ref: transcription.decision_id ?? recording.decision_id };
  }
}
