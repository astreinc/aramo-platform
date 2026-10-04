import type { PlacementView } from '../placement/types';
import type { PreStartPlacementRequirements } from '../pre-start/types';
import type { TalentRecordView } from '../talent/types';

// Shared journey helpers — used by BOTH the Talent-tab list/drawer and the
// Workspace board embed via the shared action hook, so they live in one module
// (no duplication). Pure functions; no business authority (the backend owns
// every state these summarise).

// The relevant placement for a talent — a STARTED one, else the most recent.
export function placementFor(
  placements: readonly PlacementView[],
  talentId: string,
): PlacementView | null {
  const mine = placements.filter((p) => p.talent_record_id === talentId);
  if (mine.length === 0) return null;
  const started = mine.find((p) => p.state === 'STARTED');
  if (started !== undefined) return started;
  return [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

// Authoritative pre-start summary (BE-derived readiness/blocking), rendered
// verbatim. Null when there is no requirement set for the placement ("—").
export function summarizePreStart(r: PreStartPlacementRequirements): string | null {
  if (!r.materialized) return null;
  if (r.blocking_unresolved_count > 0) return `Blocked · ${r.blocking_unresolved_count}`;
  if (r.ready) return 'Ready';
  return 'Pending';
}

export function talentLabel(
  talents: Record<string, TalentRecordView>,
  talentId: string,
): string {
  const t = talents[talentId];
  return t ? `${t.first_name} ${t.last_name}`.trim() : 'Talent';
}

// Per-talent lazy cell state for the CLIENT + PRE-START columns. Populated ONLY
// when a talent row is opened; cached for the page lifetime (reopening does not
// refetch) and invalidated for that talent when its pipeline is transitioned.
export type JourneyCells =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly client: string | null; readonly prestart: string | null };
