// M5 PR-8b1 §4.5 — typed view projection for TalentSubmittalEvent reads.
//
// The repository projects raw rows through this shape on read; per-PR
// observability standard logs the canonical fields visible here.
//
// `event_payload` is typed as `unknown` at the boundary — per-event-
// type shapes are narrowed at consumption sites in PR-8b2+ when
// concrete emit-paths land. Casting at the boundary preserves the
// type-system discipline established for evidence's JSONB columns
// (libs/evidence/src/lib/dto/talent-job-evidence-package.view.ts) and
// engagement-event-side (libs/engagement/src/lib/dto/
// talent-engagement-event.view.ts).
//
// `created_at` is surfaced as a Date — Postgres timestamptz values
// flow through Prisma as Date instances and the application layer
// formats to ISO-8601 strings at HTTP-response boundaries (PR-8b2+
// consumer). Mirrors TalentEngagementEventView.created_at shape.

// SubmittalEventTypeValue — closed-list value type mirroring the
// Prisma SubmittalEventType enum. PR-8b1 ships one value
// (`state_transition`) per Q6 HYBRID Lead-ruling; future event types
// added via explicit directive amendment.
export type SubmittalEventTypeValue = 'state_transition';

export interface TalentSubmittalEventView {
  id: string;
  tenant_id: string;
  submittal_id: string;
  event_type: SubmittalEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}
