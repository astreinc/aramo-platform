import type { ClientSelectionState } from '../client-selection-state.js';

// The projected ClientSelectionProcess (the controller returns this shape).
export interface ClientSelectionProcessView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_id: string;
  readonly state: ClientSelectionState;
  // Optimistic-concurrency token; echo back as expected_version on the next transition.
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
