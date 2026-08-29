// Lane 2 / L2-F (F3) — an owner-attributed journey stage derived from the
// ClientSelectionProcess/InterviewSession owner (NOT from Pipeline). `source` is fixed
// to 'client-selection' so a downstream unified journey read-model (L2-H) can attribute
// the stage to its owner. This is the owner-sourced primitive that retires Pipeline's
// faked `interviewing`/`client_declined` truths (Lane2-DDR §4): a stage exists here ONLY
// because the owner rows exist — remove the owner and the stage disappears.
export type JourneyStageKind = 'INTERVIEW' | 'CLIENT_DECLINED';

export interface JourneyStageView {
  readonly stage: JourneyStageKind;
  readonly source: 'client-selection';
  readonly client_selection_process_id: string;
  readonly occurred_at: string;
}
