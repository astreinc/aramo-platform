import { Injectable, Logger } from '@nestjs/common';
import { DocumentsRepository } from '@aramo/documents';
import { SignatureRoutingRepository } from '@aramo/signature-routing';

// Aramo Sign Retention and Purge directive (ebd41d99) W11 — the ATS consumer of
// sign.envelope.purge.v1 (DocuSign Connect envelope-purge parity). Aramo Sign is an
// external vendor to the ATS: a purge only ever concerns SIGN's copy. The ATS records
// the fact on the governed Document the envelope was routed for (a DocumentEvent), and
// never modifies or deletes its own stored copy, whose retention the ATS governs (R-2).
// Idempotent per Sign event id. An envelope not routed for a Document in THIS tenant is
// acknowledged and ignored (no existence oracle, no cross-tenant write).

export const SIGN_PURGE_EVENT_SUFFIX = 'envelope.purge.v1';

const PURGE_STATES = new Set(['documents_queued', 'documents_and_metadata_queued', 'documents_and_metadata_and_redact_queued', 'documents_dequeued', 'executed']);

export function isPurgeEvent(eventType: string): boolean {
  return eventType.endsWith(SIGN_PURGE_EVENT_SUFFIX);
}

export interface PurgeFields {
  purge_state: string;
  reason: string | null;
  purge_due_at: string | null; // ISO, while queued
}

/** The purge fields of a delivered event, or null when absent or malformed (→ 400). */
export function purgeFieldsOf(event: { purge?: unknown }): PurgeFields | null {
  const p = event.purge as { purge_state?: unknown; reason?: unknown; purge_due_at?: unknown } | undefined;
  if (p === undefined || p === null || typeof p !== 'object') return null;
  if (typeof p.purge_state !== 'string' || !PURGE_STATES.has(p.purge_state)) return null;
  const due = typeof p.purge_due_at === 'string' && !Number.isNaN(Date.parse(p.purge_due_at)) ? new Date(p.purge_due_at).toISOString() : null;
  return { purge_state: p.purge_state, reason: typeof p.reason === 'string' ? p.reason : null, purge_due_at: due };
}

/** Raised by the executed-artifact pull when Aramo Sign answers 410 ENVELOPE_PURGED: terminal, never retried. */
export class EsignEnvelopePurgedError extends Error {
  constructor(public readonly envelope_id: string) {
    super(`Aramo Sign purged envelope ${envelope_id}; its executed documents are no longer available from Sign`);
    this.name = 'EsignEnvelopePurgedError';
  }
}

export type PurgeFactOutcome = 'recorded' | 'duplicate' | 'unrouted';

@Injectable()
export class EsignPurgeRecorder {
  private readonly log = new Logger('EsignPurgeRecorder');

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly routing: SignatureRoutingRepository,
  ) {}

  async record(input: {
    tenant_id: string;
    envelope_id: string;
    fact_key: string;
    purge_state: string;
    reason: string | null;
    purge_due_at?: string | null;
    correlation_id?: string;
    requestId: string;
  }): Promise<PurgeFactOutcome> {
    const route = await this.routing.findRouteByEnvelope('aramo_sign', input.envelope_id);
    if (route === null || route.tenant_id !== input.tenant_id) return 'unrouted';
    const { recorded } = await this.documents.recordEsignCopyPurgeFact({
      tenant_id: input.tenant_id,
      document_id: route.document_id,
      fact_key: input.fact_key,
      envelope_id: input.envelope_id,
      purge_state: input.purge_state,
      reason: input.reason,
      purge_due_at: input.purge_due_at ?? null,
      actor_id: input.tenant_id, // system actor for the service-driven write (esign-writeback precedent)
      ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      request_id: input.requestId,
    });
    if (recorded) this.log.log(`esign_purge_fact recorded state=${input.purge_state} envelope_id=${input.envelope_id} document_id=${route.document_id}`);
    return recorded ? 'recorded' : 'duplicate';
  }
}
