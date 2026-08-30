// Lane 2 / L2-G (Part 3) — bridge types. The bridge lib owns orchestration BOOKKEEPING
// vocabulary only; it does NOT own Placement or Pipeline lifecycle rules.

// The classified outcome of processing one placement event (recorded on the inbox row).
// Every one is a PROCESSED terminal — a classified skip is still processed, never left
// pending to retry forever. TRANSIENT failure is NOT an outcome (the row stays pending).
export const INBOX_OUTCOME_CODES = [
  'completed', // STARTED → Pipeline COMPLETE succeeded
  'dispositioned', // FELL_THROUGH/NO_SHOW → Pipeline downstream DISPOSITION succeeded
  'already_satisfied', // the episode was already completed / already disposed (recognized-satisfied)
  'no_pipeline_lineage', // the submittal carries no pipeline_id → no episode to act on
  'pipeline_not_live', // the resolved episode is not a live/actionable state
  'event_not_actionable', // a placement to_state the bridge does not act on
] as const;
export type InboxOutcomeCode = (typeof INBOX_OUTCOME_CODES)[number];

// The `placement.process.state_changed` event payload the placement aggregate emits (the
// stored authoritative lineage the orchestrator resolves from). Mirrors
// libs/placement PlacementRepository's outbox payload — carried by UUID reference only.
export interface PlacementStateChangedPayload {
  readonly placement_process_id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly occurred_at: string;
  readonly reason_code?: string | null;
  readonly reason_label_snapshot?: string | null;
}

// The event_type constant the bridge consumes.
export const PLACEMENT_STATE_CHANGED_EVENT_TYPE =
  'placement.process.state_changed';
