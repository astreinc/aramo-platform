import type { EngagementEventTypeValue } from '../engagement-event.js';

// Typed view projection for TalentEngagementEvent reads (M5 PR-2
// directive §4.4). The repository projects raw rows through this shape
// on read; per-PR observability standard logs the canonical fields
// visible here.
//
// `event_payload` is typed as `unknown` at the boundary — per-event-
// type shapes are narrowed at consumption sites in M5 PR-3+ when
// concrete emit-paths land. Casting at the boundary preserves the
// type-system discipline established for evidence's JSONB columns
// (libs/evidence/src/lib/dto/talent-job-evidence-package.view.ts).
//
// `created_at` is surfaced as a Date — Postgres timestamptz values
// flow through Prisma as Date instances and the application layer
// formats to ISO-8601 strings at HTTP-response boundaries (M5 PR-4+
// consumer). Mirrors TalentJobEngagementView.created_at shape.
export interface TalentEngagementEventView {
  id: string;
  tenant_id: string;
  engagement_id: string;
  event_type: EngagementEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}
