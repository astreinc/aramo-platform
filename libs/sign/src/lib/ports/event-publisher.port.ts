import { Injectable } from '@nestjs/common';

// DOC-4 (R-4-7) — the operational external-event boundary. E-Sign publishes
// executed-envelope notifications through this port; the composition root binds
// the SNS adapter (apps/sign-service) or the local no-op publisher (DARK
// default). NO bytes/PII cross the bus (§12/§341): events carry refs only —
// apps/api's consumer pulls executed bytes + evidence + certificate over
// authorized HTTP.

export const EVENT_PUBLISHER_PORT = 'EVENT_PUBLISHER_PORT';

export interface EsignDomainEvent {
  event_type: string; // e.g. 'sign.envelope.executed.v1'
  envelope_id: string;
  tenant_id: string;
  correlation_id: string;
  // Refs only — no document bytes, no PII.
  artifact_refs: {
    executed_document_ids: string[];
    has_certificate: boolean;
  };
  // Retention and Purge directive (ebd41d99) R-14/LD-8 — set on sign.envelope.purge.v1 only.
  purge?: EsignPurgeEventFields;
}

// The DocuSign Connect envelope-purge fields (purgeState values), plus 'executed' (LD-6).
export type EsignPurgeState =
  | 'documents_queued'
  | 'documents_and_metadata_queued'
  | 'documents_and_metadata_and_redact_queued'
  | 'documents_dequeued'
  | 'executed';

export type EsignPurgeReason = 'retention' | 'targeted' | 'all_parties_deleted' | 'account_closed' | 'manual';

export interface EsignPurgeEventFields {
  purge_state: EsignPurgeState;
  purge_due_at: string | null; // ISO; null once executed
  reason: EsignPurgeReason;
}

export const SIGN_ENVELOPE_PURGE_EVENT_TYPE = 'sign.envelope.purge.v1';

export interface EventPublisherPort {
  publish(event: EsignDomainEvent): Promise<void>;
}

// DARK default — collects published events in-memory (local/CI/unwired-prod).
// The real SNS adapter (apps/sign-service) replaces this when configured.
@Injectable()
export class LocalEventPublisher implements EventPublisherPort {
  readonly published: EsignDomainEvent[] = [];
  async publish(event: EsignDomainEvent): Promise<void> {
    this.published.push(event);
  }
}
