// Talent × Requisition 360 — route path + the navigation state entry points pass so
// the page's Back returns to the originating view.

/** Route builder — the single place entry points get the path from. */
export function talentRequisition360Path(requisitionId: string, talentId: string): string {
  return `/requisitions/${requisitionId}/talent/${talentId}`;
}

/** Navigation state an entry point passes so Back returns to it. */
export interface Tr360NavState {
  readonly tr360From?: 'requisitions' | 'requisition' | 'talent-360';
}
