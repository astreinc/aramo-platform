// ADR-0033 — the canonical, versioned cross-service event envelope.
//
// Every durable business event that crosses an Aramo service boundary via the
// transactional-outbox → EventBridge → SQS backbone carries this envelope. It is
// transport-agnostic: the same envelope is produced from a domain-local outbox
// row and consumed by a runtime-neutral handler, regardless of EventBridge/SQS/
// Lambda specifics.
//
// Tenant identity on an envelope is ROUTING / CONTEXT metadata, never
// authorization authority: a consumer MUST revalidate authoritative tenant /
// resource ownership against its own system of record before acting. See
// ADR-0033 Decision 4.

// The envelope carried end-to-end. `TPayload` is the domain-specific body; it is
// itself versioned via `event_version` so a consumer can branch on shape.
export interface AramoEventEnvelope<TPayload = unknown> {
  // Globally unique AND stable across re-publication of the same outbox row.
  // Anchors at-least-once idempotency: a duplicate EventBridge/SQS delivery
  // carries the same event_id, so an idempotent consumer no-ops the replay.
  readonly event_id: string;
  // Domain event name, e.g. 'talent_intake.extraction_requested'.
  readonly event_type: string;
  // Explicit schema version of event_type + payload, e.g. 'v1'. Never implicit.
  readonly event_version: string;
  // Routing/context ONLY — not authorization. Consumers revalidate ownership.
  readonly tenant_id: string;
  // The producing service/context, e.g. 'talent-intake'.
  readonly source: string;
  // The entity the event is about, e.g. 'talent_intake_draft'.
  readonly subject_type: string;
  readonly subject_id: string;
  // Authoritative UTC instant the business fact occurred (ISO-8601, 'Z').
  readonly occurred_at: string;
  // Propagated end-to-end for tracing: the originating request/flow.
  readonly correlation_id: string;
  // The event/command that directly caused this one; null at a flow root.
  readonly causation_id: string | null;
  readonly payload: TPayload;
}

// The canonical, versioned durable outbox row shape a publisher maps to an
// envelope. A domain-local outbox table satisfies this once the ADR-0033
// envelope columns are added additively (ADD-not-rename). `source`,
// `subject_type`, `subject_id`, `event_version`, `causation_id` are nullable
// here so a not-yet-migrated row still maps (falling back to derivable
// defaults) without a hard failure during the migration window.
export interface CanonicalOutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly event_payload: unknown;
  readonly created_at: Date;
  readonly event_version?: string | null;
  readonly source?: string | null;
  readonly subject_type?: string | null;
  readonly subject_id?: string | null;
  readonly correlation_id?: string | null;
  readonly causation_id?: string | null;
}

// Fallbacks applied when a (pre-migration) outbox row lacks an envelope column.
export interface EnvelopeDefaults {
  // Required: the producing service, when the row has no `source` column yet.
  readonly source: string;
  // Default schema version when the row has none (e.g. 'v1').
  readonly event_version: string;
  // Derive a subject_type from the row when the column is absent.
  readonly subjectTypeFor: (row: CanonicalOutboxRow) => string;
  // Derive a subject_id from the row/payload when the column is absent.
  readonly subjectIdFor: (row: CanonicalOutboxRow) => string;
  // Derive a correlation_id from the row/payload when the column is absent.
  // Falls back to the row id (always present) so correlation is never empty.
  readonly correlationIdFor?: (row: CanonicalOutboxRow) => string | null;
}

// Map a durable outbox row to a canonical envelope. The outbox row id becomes
// the event_id (stable → idempotency anchor) and created_at becomes occurred_at
// (the authoritative instant, emitted UTC). Pure + deterministic: no clock, no
// randomness — identical input always yields an identical envelope, which is
// what makes replay/duplicate-publish harmless.
export function buildEventEnvelope(
  row: CanonicalOutboxRow,
  defaults: EnvelopeDefaults,
): AramoEventEnvelope {
  const correlation =
    row.correlation_id ??
    defaults.correlationIdFor?.(row) ??
    row.id;
  return {
    event_id: row.id,
    event_type: row.event_type,
    event_version: row.event_version ?? defaults.event_version,
    tenant_id: row.tenant_id,
    source: row.source ?? defaults.source,
    subject_type: row.subject_type ?? defaults.subjectTypeFor(row),
    subject_id: row.subject_id ?? defaults.subjectIdFor(row),
    occurred_at: row.created_at.toISOString(),
    correlation_id: correlation,
    causation_id: row.causation_id ?? null,
    payload: row.event_payload,
  };
}
