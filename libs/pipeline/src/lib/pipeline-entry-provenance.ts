// Lane 2 / L2-D — PipelineEntryProvenance domain: the closed origin classification
// + the validated write-input contract. The specific provider/system is a free-form
// `source_system` string (IntegrationConnection.provider_key discipline), never a
// frozen vendor enum; only the origin CLASS is closed. See schema.prisma
// `PipelineEntryOriginType` + `PipelineEntryProvenance`.

import { ACTOR_KINDS, type ActorKind } from '@aramo/auth';

// The 12 LOCKED origin classes (D-directive §Decision). Mirror of the DB enum.
export const PIPELINE_ENTRY_ORIGIN_VALUES = [
  'MANUAL_RECRUITER',
  'ARAMO_SOURCING',
  'INBOUND_APPLICATION',
  'INTERNAL_REDISCOVERY',
  'REFERRAL',
  'EXTERNAL_ATS',
  'VMS',
  'JOB_BOARD',
  'CAREER_SITE',
  'TALENT_PORTAL',
  'IMPORT',
  'SYSTEM_RECONCILIATION',
] as const;
export type PipelineEntryOriginType =
  (typeof PIPELINE_ENTRY_ORIGIN_VALUES)[number];

export function isPipelineEntryOriginType(
  v: unknown,
): v is PipelineEntryOriginType {
  return (
    typeof v === 'string' &&
    (PIPELINE_ENTRY_ORIGIN_VALUES as readonly string[]).includes(v)
  );
}

// initiated_by_kind is validated at the write boundary against the closed
// ACTOR_KINDS set owned by libs/auth (Rule D — NOT re-declared as a DB enum).
export function isValidInitiatedByKind(v: unknown): v is ActorKind {
  return (
    typeof v === 'string' && (ACTOR_KINDS as readonly string[]).includes(v)
  );
}

// The validated write-input for one entry-provenance row. The SAME object is the
// single source that (a) writes the durable PipelineEntryProvenance row and
// (b) enriches the pipeline.created event payload (v1.1 event-enrichment ruling) —
// so the event can never diverge from the durable record.
export interface EntryProvenanceInput {
  readonly origin_type: PipelineEntryOriginType;
  readonly initiated_by_kind: ActorKind;
  readonly initiated_by_id?: string | null;
  readonly source_system?: string | null;
  readonly source_connection_id?: string | null;
  readonly external_object_type?: string | null;
  readonly external_object_id?: string | null;
  readonly external_event_id?: string | null;
  readonly observed_at?: Date | null;
  readonly metadata?: Record<string, unknown> | null;
}

// The subset of entry-provenance fields projected onto the `pipeline.created`
// event payload (v1.1 ruling — the event is an immutable projection of the durable
// record, not a second authority). Nullable fields stay nullable.
export interface EntryProvenanceEventProjection {
  readonly origin_type: PipelineEntryOriginType;
  readonly source_system: string | null;
  readonly source_connection_id: string | null;
  readonly initiated_by_kind: ActorKind;
}

export function projectEntryProvenanceForEvent(
  input: EntryProvenanceInput,
): EntryProvenanceEventProjection {
  return {
    origin_type: input.origin_type,
    source_system: input.source_system ?? null,
    source_connection_id: input.source_connection_id ?? null,
    initiated_by_kind: input.initiated_by_kind,
  };
}
