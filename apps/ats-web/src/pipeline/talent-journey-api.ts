import { apiClient } from '@aramo/fe-foundation';

// Lane 2 / L2-H — the Unified Talent Journey read client. The FE consumes the BE-composed
// owner-attributed stage as the SINGLE stage source; it does NOT re-derive offer/placement/
// decline labels locally (that FE derivation is a placement-BOARD concern only, never the
// journey funnel). Shape mirrors the apps/api TalentRequisitionJourney contract.

export type JourneyOwner =
  | 'pipeline'
  | 'submittal'
  | 'client-selection'
  | 'interview'
  | 'offer'
  | 'placement'
  | 'pre-start'
  | 'assignment';

export interface JourneyStageElement {
  readonly stage: string;
  readonly owner: JourneyOwner;
  readonly source_object_id: string;
  readonly occurred_at?: string;
}

export interface JourneyAction {
  readonly action: string;
  readonly owner: JourneyOwner;
  readonly command_route: string;
}

export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: string;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: Readonly<Record<string, string | null>>;
  readonly actions: readonly JourneyAction[];
}

// GET /v1/pipelines/:id/journey — the composed journey for one pipeline episode. A non-visible
// / cross-tenant episode is concealed as 404 by the server (surfaced as a foundation ApiError).
export async function getTalentJourney(pipelineId: string): Promise<TalentRequisitionJourney> {
  return apiClient.get<TalentRequisitionJourney>(
    `/v1/pipelines/${encodeURIComponent(pipelineId)}/journey`,
  );
}
