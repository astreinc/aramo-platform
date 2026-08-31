import {
  PIPELINE_ENTRY_ORIGIN_VALUES,
  type PipelineEntryOriginType,
  type EntryProvenanceInput,
} from './pipeline-entry-provenance.js';

// Lane 2 / L2-I (D2) — the canonical EXTERNAL SOURCE-EVENT contract. A provider connector
// (external ATS / VMS / job board / career site / talent portal) that observes a sourcing event
// resolves it into this shape; a FUTURE connector then attaches an entry to an episode through the
// GOVERNED create/entry path (PipelineRepository.create with entry_provenance) — NEVER by
// writing a Pipeline row directly (SB-7). It is built on the L2-D provenance columns (Rule D:
// the origin vocabulary + provenance shape are IMPORTED from pipeline-entry-provenance, never
// restated) and carries connection-scoped source identifiers only (no PII, no Talent-trust).

// The PROVIDER-SOURCED subset of the L2-D origin vocabulary — the origins an external connector
// may legitimately claim. Derived from PIPELINE_ENTRY_ORIGIN_VALUES (Rule D); the internal
// origins (MANUAL_RECRUITER / ARAMO_SOURCING / INTERNAL_REDISCOVERY / SYSTEM_RECONCILIATION /
// IMPORT / REFERRAL / INBOUND_APPLICATION) are NOT provider-mappable — a connector can never
// claim a human-recruiter or internal origin.
const PROVIDER_SOURCED_ORIGIN_SET: ReadonlySet<string> = new Set(
  (PIPELINE_ENTRY_ORIGIN_VALUES as readonly string[]).filter((o) =>
    ['EXTERNAL_ATS', 'VMS', 'JOB_BOARD', 'CAREER_SITE', 'TALENT_PORTAL'].includes(o),
  ),
);

export const PROVIDER_SOURCED_ORIGINS: readonly PipelineEntryOriginType[] = [
  ...PROVIDER_SOURCED_ORIGIN_SET,
] as PipelineEntryOriginType[];

export function isProviderSourcedOrigin(origin: string): origin is PipelineEntryOriginType {
  return PROVIDER_SOURCED_ORIGIN_SET.has(origin);
}

// The canonical external source-event a connector emits. Connection-scoped identifiers only;
// the (talent, requisition) it attaches to are UUID refs (no PII carried).
export interface ExternalSourceEvent {
  readonly origin_type: PipelineEntryOriginType; // MUST be a provider-sourced origin
  readonly source_system: string; // IntegrationConnection.provider_key discipline
  readonly source_connection_id: string; // the connection scope
  readonly external_object_type: string; // e.g. 'application' | 'shortlist_item' | 'vms_worker_record'
  readonly external_object_id: string; // the provider's object id (opaque)
  readonly external_event_id: string; // idempotency grain for the source event
  readonly observed_at: Date;
  readonly talent_record_id: string; // the entry target (UUID ref)
  readonly requisition_id: string; // the entry target (UUID ref)
  readonly metadata?: Record<string, unknown> | null;
}

// Project an external source-event onto the governed L2-D EntryProvenanceInput the create/entry
// path consumes. The connector is a SYSTEM actor (initiated_by_kind='system'); a non-provider
// origin is refused (a connector cannot claim a human/internal origin). This is the ONLY bridge
// from a provider observation to an episode entry — there is no direct-row-write path.
export function projectExternalSourceEventToEntryProvenance(
  event: ExternalSourceEvent,
): EntryProvenanceInput {
  if (!isProviderSourcedOrigin(event.origin_type)) {
    throw new Error(
      `origin_type '${event.origin_type}' is not a provider-sourced origin (a connector cannot claim an internal/human origin)`,
    );
  }
  return {
    origin_type: event.origin_type,
    initiated_by_kind: 'system',
    initiated_by_id: null,
    source_system: event.source_system,
    source_connection_id: event.source_connection_id,
    external_object_type: event.external_object_type,
    external_object_id: event.external_object_id,
    external_event_id: event.external_event_id,
    observed_at: event.observed_at,
    metadata: event.metadata ?? null,
  };
}
