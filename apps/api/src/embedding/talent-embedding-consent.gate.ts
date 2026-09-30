import { Injectable } from '@nestjs/common';
import { ConsentService } from '@aramo/consent';

import type {
  TalentEmbeddingConsentDecision,
  TalentEmbeddingConsentPort,
} from './talent-embedding-consent.port.js';

// Enterprise Search GS-2 P4 — production ai_processing consent gate for the Talent embedding path.
// Binds the embedding pipeline to the SOLE Consent authority via the same internal enforcement
// entrypoint (`checkOperationForService`) the CI transcript/processing gates use — it does NOT
// duplicate consent logic, mint a session, or mutate consent. The Talent subject is the
// talent_record_id directly (the embedding is Talent-scoped), so no interaction indirection.
//
// Fail-closed: allowed ONLY on an explicit `allowed` decision. A definite non-allowed decision is
// surfaced with its reason so the worker can distinguish a stable revocation (`denied` → invalidate
// the existing vector) from an uncertain state (`error` → skip, do not invalidate). A thrown error
// (transient infra) is intentionally NOT caught here — it propagates to the worker's retry path so a
// momentary consent-authority outage never masquerades as a revocation and deletes a live vector.
@Injectable()
export class TalentEmbeddingConsentGate implements TalentEmbeddingConsentPort {
  constructor(private readonly consent: ConsentService) {}

  async evaluate(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentEmbeddingConsentDecision> {
    const decision = await this.consent.checkOperationForService({
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      operation: 'ai_processing',
    });
    if (decision.result !== 'allowed') {
      return { allowed: false, reason: decision.result };
    }
    return { allowed: true, consent_decision_ref: decision.decision_id };
  }
}
