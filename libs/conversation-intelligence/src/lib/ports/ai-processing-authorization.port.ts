// CI-B6 — the ai_processing authorization seam (directive §4). Consent remains
// the SOLE authority (libs/consent). The composition root binds a gate that
// resolves the Talent from the DURABLE interaction association and calls the
// Consent authority for the INDEPENDENT `ai_processing` operation — never
// inferring it from recording/transcription/transcript existence. B6 fails
// closed. The worker is an enforcement caller, not a consent-granting actor.

export type AiProcessingAuthorizationResult =
  | { readonly allowed: true; readonly consent_decision_ref?: string }
  | { readonly allowed: false; readonly reason: 'denied' }
  | { readonly allowed: false; readonly reason: 'no_talent' }
  | { readonly allowed: false; readonly reason: 'ambiguous_talent' };

export interface AiProcessingAuthorizationPort {
  /** Evaluate ai_processing consent for the Talent tied to this interaction. */
  evaluate(input: {
    tenant_id: string;
    interaction_id: string;
  }): Promise<AiProcessingAuthorizationResult>;
}

export const AI_PROCESSING_AUTHORIZATION = 'CI_AI_PROCESSING_AUTHORIZATION';
