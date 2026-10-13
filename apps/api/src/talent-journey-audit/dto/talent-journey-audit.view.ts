// INC-1e (TIP-E2E) — Correlated journey audit view.
//
// A minimally-sufficient, READ-ONLY trace over EXISTING immutable domain events,
// keyed by the DURABLE domain IDs so a reader can correlate a Talent's journey
// ACROSS separate HTTP requests (never a per-request requestId). This view composes
// authority; it NEVER creates a new audit platform, ActivityType, or trust projection.

// The durable correlation spine — the stable domain IDs that join this submittal's
// trace to the OTHER authoritative immutable stores (the pinned Examination snapshot,
// the Evidence package, the trust ResolutionSubjectRef, pipeline events) WITHOUT a
// per-request correlation id. requisition_id = the submittal's job_id (shared-UUID).
export interface JourneyAuditSpine {
  readonly submittal_id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly examination_id: string;
  readonly evidence_package_id: string;
}

// The authoritative domain that OWNS an audit entry. Kept distinct so the trace never
// conflates original evidence, screening findings, trust projections, the Examination,
// pipeline events, and submittal transitions (INC-1e §45). This increment surfaces the
// submittal-transition grain; other sources join via the spine IDs above.
export type JourneyAuditSource = 'submittal';

export interface JourneyAuditEntry {
  readonly source: JourneyAuditSource;
  // The immutable event's closed-list type (a submittal state transition).
  readonly kind: string;
  readonly occurred_at: string; // ISO-8601
  // Authenticated actor provenance surfaced from the immutable event payload where it
  // was recorded; an HONEST null when the event did not capture an actor (never fabricated).
  readonly actor_id: string | null;
  // The event's OWN durable id (so a reader can reference a specific immutable row).
  readonly submittal_event_id: string;
}

export interface TalentJourneyAuditView {
  readonly spine: JourneyAuditSpine;
  // Record-level authenticated provenance (who created the submittal grain). Distinct
  // from the per-event actors above.
  readonly record_provenance: {
    readonly created_by: string;
  };
  // The immutable submittal-transition timeline, chronological (created_at asc).
  readonly entries: readonly JourneyAuditEntry[];
}
