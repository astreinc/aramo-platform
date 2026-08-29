// Lane 2 / L2-E (SB-5) — the pure submitted-overlay semantic, shared by the
// snapshot reads (R1 rollup, R2 funnel band, R5 current_stage). It reproduces the
// retired Pipeline mirror's OVERWRITE: a (talent, requisition) grain that has been
// submitted reads as effective status `submitted` IFF its CURRENT pipeline episode
// has not advanced past submitted (interviewing/offered/placed) and is not terminal.
//
// Parity (SB-5): with the mirror STILL writing, a submitted grain's current episode
// status IS 'submitted', so the overlay is a NO-OP (the raw bucket already counts it
// in submitted). After the mirror is removed, that episode rests at a pre-submitted
// stage (e.g. qualifying), and the overlay MOVES it from the raw bucket into
// submitted — yielding identical buckets to the pre-removal read. This is what makes
// the mirror removal value-preserving.

// The pre-submitted ACTIVE stages: an episode here has not advanced past submitted.
// `submitted` itself is excluded (already-counted). interviewing/offered/placed =
// advanced → raw wins. Terminals (not_in_consideration/client_declined/completed) =
// raw wins. `no_status` is import-legacy but pre-submitted for overlay purposes.
export const PRE_SUBMITTED_ACTIVE_STAGES: ReadonlySet<string> = new Set([
  'no_status',
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  'qualified',
]);

export interface OverlayGrain {
  readonly talent_id: string;
  readonly requisition_id: string;
}

function grainKey(talent_id: string, requisition_id: string): string {
  return `${talent_id}:${requisition_id}`;
}

// Whether a submitted grain, given its current episode status, is effectively
// `submitted` (i.e. the overlay should count it there rather than in its raw stage).
// `undefined` current status (no episode found) → not overlaid.
export function isEffectivelySubmitted(currentStatus: string | undefined): boolean {
  return currentStatus !== undefined && PRE_SUBMITTED_ACTIVE_STAGES.has(currentStatus);
}

// Apply the overlay to a set of {status, count} buckets (as countByStatus returns).
// For each submitted grain whose current episode is pre-submitted, move one count
// from its raw stage bucket into `submitted`. Grains already at `submitted`
// (mirror-present parity) or advanced/terminal are left untouched. Zero/empty
// buckets are dropped, matching countByStatus's non-zero GROUP BY output.
export function applySubmittedOverlayToBuckets(
  rawBuckets: ReadonlyArray<{ status: string; count: number }>,
  submittedGrains: readonly OverlayGrain[],
  currentStatusByGrain: ReadonlyMap<string, string>,
): Array<{ status: string; count: number }> {
  const m = new Map<string, number>();
  for (const b of rawBuckets) m.set(b.status, b.count);
  for (const g of submittedGrains) {
    const cur = currentStatusByGrain.get(grainKey(g.talent_id, g.requisition_id));
    if (!isEffectivelySubmitted(cur)) continue; // already-submitted / advanced / terminal / absent
    m.set(cur as string, (m.get(cur as string) ?? 0) - 1);
    m.set('submitted', (m.get('submitted') ?? 0) + 1);
  }
  return [...m.entries()]
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }));
}

// R2 funnel-band variant: the band {submitted, interviewing, offered} counts
// distinct (talent, req) grains whose CURRENT episode is in the band. The overlay
// ADDS submitted grains whose current episode is pre-submitted (so not already in
// any band bucket) to the submitted band count; grains already at submitted (parity)
// or already advanced (interviewing/offered — counted by raw) are not double-added.
// Returns the additional submitted-band count to fold into the raw band result per
// requisition.
export function submittedBandOverlayByRequisition(
  submittedGrains: readonly OverlayGrain[],
  currentStatusByGrain: ReadonlyMap<string, string>,
): Map<string, number> {
  const byReq = new Map<string, number>();
  for (const g of submittedGrains) {
    const cur = currentStatusByGrain.get(grainKey(g.talent_id, g.requisition_id));
    if (!isEffectivelySubmitted(cur)) continue;
    byReq.set(g.requisition_id, (byReq.get(g.requisition_id) ?? 0) + 1);
  }
  return byReq;
}
