import { Injectable } from '@nestjs/common';
import { DocumentsRepository } from '@aramo/documents';
import { SignatureRoutingRepository } from '@aramo/signature-routing';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R2 (DEF-12; RTR-TEMPLATE-1 §18) — Aramo Sign
// published that an envelope ended WITHOUT execution (the signer declined, the window passed, or
// the sender voided it). Resolve the governed Document the envelope was routed for (the frozen
// SignatureRequestRoute) in THIS tenant, and record the outcome so RTR readiness never keeps
// showing "Awaiting signature". Idempotent: a redelivered event changes nothing; EXECUTED is never
// overwritten (DocumentsRepository.markSigningEnded).
export const SIGN_ENDED_EVENT_STATUS: Readonly<Record<string, 'DECLINED' | 'EXPIRED' | 'VOIDED'>> = {
  'envelope.declined.v1': 'DECLINED',
  'envelope.expired.v1': 'EXPIRED',
  'envelope.voided.v1': 'VOIDED',
};

/** The ended-signing outcome an event type carries (prefix-agnostic: sign.* / esign.*), or null. */
export function signingEndedStatusFor(eventType: string): 'DECLINED' | 'EXPIRED' | 'VOIDED' | null {
  for (const [suffix, status] of Object.entries(SIGN_ENDED_EVENT_STATUS)) {
    if (eventType.endsWith(suffix)) return status;
  }
  return null;
}

export type SigningEndedOutcome = 'recorded' | 'already_final' | 'unrouted';

@Injectable()
export class EsignSigningEndedRecorder {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly routing: SignatureRoutingRepository,
  ) {}

  async record(input: {
    tenant_id: string;
    envelope_id: string;
    status: 'DECLINED' | 'EXPIRED' | 'VOIDED';
    correlation_id?: string;
    requestId: string;
  }): Promise<SigningEndedOutcome> {
    const route = await this.routing.findRouteByEnvelope('aramo_sign', input.envelope_id);
    // An envelope not routed for a governed document in THIS tenant is acknowledged and ignored —
    // never an existence oracle, never a cross-tenant write.
    if (route === null || route.tenant_id !== input.tenant_id) return 'unrouted';
    const { changed } = await this.documents.markSigningEnded({
      tenant_id: input.tenant_id,
      document_id: route.document_id,
      status: input.status,
      actor_id: input.tenant_id, // system actor for the service-driven write (esign-writeback precedent)
      ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      request_id: input.requestId,
    });
    return changed ? 'recorded' : 'already_final';
  }
}
