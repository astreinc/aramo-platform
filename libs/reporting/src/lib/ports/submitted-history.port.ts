// Lane 2 / L2-E (SB-5 / D-4) — the REPORTING-OWNED submitted-history port.
//
// This is the seam that lets ReportingService derive the submitted fact from the
// authoritative Submittal EVENT history WITHOUT libs/reporting importing
// @aramo/submittal. libs/reporting OWNS this interface (it defines the semantic —
// "the first canonical submitted_to_ats transition per (talent, requisition)
// grain"); the IMPLEMENTATION is a @aramo/submittal-backed adapter wired at the
// apps/api composition root. The port carries typed values only — no bare string
// literals (e.g. 'submitted_to_ats') cross it; that predicate lives on the
// submittal side of the adapter.
//
// Architecture (Architect ruling Q3): DEPENDENCY-ON-DATA = YES;
// DIRECT-DOMAIN/REPO/PRISMA-IMPORT in libs/reporting = NO; REPORTING-PORT = YES;
// COMPOSITION-ADAPTER = YES. The structural boundary guard asserts libs/reporting
// has zero @aramo/submittal import; the runtime integration proof asserts the
// metric sources from the event history, not PipelineStatusHistory.

// One submitted (talent, requisition) grain: the FIRST canonical submitted
// transition, durable across the submittal's later confirmed/revoked states.
export interface SubmittedHistoryGrain {
  readonly talent_id: string;
  readonly requisition_id: string;
  // The pipeline episode linked to the submittal that first submitted — carried so
  // R3 time-to-submit can join pipeline.created_at. Null if the submittal had no
  // linked episode.
  readonly pipeline_id: string | null;
  // The transition instant (first submitted_to_ats event's created_at).
  readonly first_submitted_at: Date;
}

export interface SubmittedHistoryQuery {
  readonly tenant_id: string;
  // Restrict to these requisitions (the reporting visibility set). Omit = tenant-wide.
  readonly requisition_ids?: readonly string[];
  // Restrict to these talents (enrichment batch). Omit = all.
  readonly talent_ids?: readonly string[];
  // Keep only grains whose FIRST submitted instant is >= since (flow-window reads).
  readonly since?: Date;
}

export interface SubmittedHistoryPort {
  findFirstSubmittedByGrain(
    query: SubmittedHistoryQuery,
  ): Promise<readonly SubmittedHistoryGrain[]>;
}

// DI token — the interface has no runtime identity, so ReportingService injects the
// implementation by this token (@Inject(SUBMITTED_HISTORY_PORT)). The apps/api
// composition root binds it to the @aramo/submittal-backed adapter.
export const SUBMITTED_HISTORY_PORT = Symbol('SUBMITTED_HISTORY_PORT');
