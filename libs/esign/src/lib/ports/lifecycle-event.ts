// E-Sign OC v2 — the GENERIC outbound lifecycle event (Independent-Digital-
// Signature-Platform Directive sections 5, 6). This is the platform's public
// signing-fact contract: generic signing-domain vocabulary ONLY — no RTR / Offer
// / Submittal / Placement semantics, no document bytes, no raw signing tokens.
// The consumer uses envelope_id to pull authoritative executed artifacts.
//
// event_id is STABLE across every delivery retry: it is the durable OutboxEvent
// row identity, so the consumer can deduplicate redeliveries reliably.

export const ESIGN_LIFECYCLE_EVENT_VERSION = 1 as const;

export interface EsignLifecycleEventArtifactRefs {
  executed_document_ids: string[];
  has_certificate: boolean;
}

export interface EsignLifecycleEvent {
  event_id: string; // = durable outbox row id; identical across retries
  event_type: string; // generic, e.g. 'esign.envelope.executed.v1'
  event_version: number;
  occurred_at: string; // ISO 8601 (outbox row created_at)
  tenant_id: string; // consumer enforces tenant isolation independently
  envelope_id: string;
  correlation_id: string;
  artifact_refs: EsignLifecycleEventArtifactRefs; // identifiers only
}

// The minimal shape of an OutboxEvent row this builder needs.
export interface OutboxRowForLifecycleEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  created_at: Date;
  event_payload: unknown;
}

// Build the wire event from a durable outbox row. event_id = row.id (stable),
// occurred_at = row.created_at. The payload carries envelope_id / correlation_id /
// artifact_refs (written at enqueue time).
export function toLifecycleEvent(row: OutboxRowForLifecycleEvent): EsignLifecycleEvent {
  const payload = (row.event_payload ?? {}) as {
    envelope_id?: string;
    correlation_id?: string;
    artifact_refs?: EsignLifecycleEventArtifactRefs;
  };
  return {
    event_id: row.id,
    event_type: row.event_type,
    event_version: ESIGN_LIFECYCLE_EVENT_VERSION,
    occurred_at: row.created_at.toISOString(),
    tenant_id: row.tenant_id,
    envelope_id: payload.envelope_id ?? '',
    correlation_id: payload.correlation_id ?? '',
    artifact_refs: payload.artifact_refs ?? { executed_document_ids: [], has_certificate: false },
  };
}
