// CI-B6 — the production ai_processing authorization gate. Binds B6 to the SOLE
// Consent authority (libs/consent). Resolves the Talent from the DURABLE
// interaction association (never inference) and checks the INDEPENDENT
// `ai_processing` operation — never inferred from recording/transcription or
// transcript existence. Fail-closed. Mirrors the B5Z ConsentTranscriptGate; the
// worker is an enforcement caller, not a consent-granting actor.

import { Injectable } from '@nestjs/common';
import { CommunicationsRepository } from '@aramo/communications';
import { ConsentService } from '@aramo/consent';
import type {
  AiProcessingAuthorizationPort,
  AiProcessingAuthorizationResult,
} from '@aramo/conversation-intelligence';

@Injectable()
export class AiProcessingConsentGate implements AiProcessingAuthorizationPort {
  constructor(
    private readonly comms: CommunicationsRepository,
    private readonly consent: ConsentService,
  ) {}

  async evaluate(input: {
    tenant_id: string;
    interaction_id: string;
  }): Promise<AiProcessingAuthorizationResult> {
    // Talent from DURABLE association truth only (subject/talent_record).
    const talentIds = await this.comms.findTalentSubjectIdsForInteraction(
      input.tenant_id,
      input.interaction_id,
    );
    if (talentIds.length === 0) return { allowed: false, reason: 'no_talent' };
    if (talentIds.length > 1) return { allowed: false, reason: 'ambiguous_talent' };

    // Independent ai_processing check against the canonical Consent authority.
    const decision = await this.consent.checkOperationForService({
      tenant_id: input.tenant_id,
      talent_record_id: talentIds[0] as string,
      operation: 'ai_processing',
    });
    if (decision.result !== 'allowed') return { allowed: false, reason: 'denied' };
    return { allowed: true, consent_decision_ref: decision.decision_id };
  }
}
