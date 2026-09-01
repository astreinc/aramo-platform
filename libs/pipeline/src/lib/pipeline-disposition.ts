// Lane 2 / L2-C (D-5) — PipelineDisposition domain: the authority-partitioned,
// immutable reason a pipeline episode was terminated. Written inside the
// terminal-transition tx (DISPOSITION → not_in_consideration; COMPLETE →
// completed). ONE disposition per pipeline_id (UNIQUE), exact-name translated.

// The FOUR authority classes are LOCKED (D-5). Who is speaking when the episode
// closes: the recruiter, the talent, the engagement/requisition, or a downstream
// outcome (placement lifecycle). DOWNSTREAM_OUTCOME enters ONLY via the system
// path and MUST carry source_provenance (owning-aggregate UUID lineage).
export const PIPELINE_DISPOSITION_AUTHORITY_VALUES = [
  'RECRUITER',
  'TALENT',
  'ENGAGEMENT',
  'DOWNSTREAM_OUTCOME',
] as const;
export type PipelineDispositionAuthority =
  (typeof PIPELINE_DISPOSITION_AUTHORITY_VALUES)[number];

export function isPipelineDispositionAuthority(
  v: unknown,
): v is PipelineDispositionAuthority {
  return (
    typeof v === 'string' &&
    (PIPELINE_DISPOSITION_AUTHORITY_VALUES as readonly string[]).includes(v)
  );
}

// A recruiter DISPOSITION may only carry these authority classes (never
// DOWNSTREAM_OUTCOME — that is system-owned and lineage-bearing).
export const RECRUITER_DISPOSITION_AUTHORITIES: readonly PipelineDispositionAuthority[] =
  ['RECRUITER', 'TALENT', 'ENGAGEMENT'];

// The reason taxonomy, keyed by authority class. Concrete codes designed at
// Gate-5 (the classes themselves are the locked D-5 surface). Each reason belongs
// to exactly one authority — the (authority, reason) pair is validated on write.
export const PIPELINE_DISPOSITION_REASONS: Record<
  PipelineDispositionAuthority,
  readonly string[]
> = {
  RECRUITER: [
    'not_a_fit',
    'skills_mismatch',
    'better_matched_elsewhere',
    'withdrawn_by_recruiter',
  ],
  TALENT: [
    'talent_declined',
    'talent_unresponsive',
    'talent_accepted_other_role',
    'compensation_misalignment',
  ],
  ENGAGEMENT: [
    'requisition_closed',
    'requisition_on_hold',
    'client_paused_engagement',
    'position_filled_externally',
  ],
  DOWNSTREAM_OUTCOME: [
    'placement_started',
    'placement_completed',
    'placement_fell_through',
    'converted_to_permanent',
    // L3-E(2) — client-consideration terminal outcomes (governed apps/api orchestration
    // dispositions the qualified episode when Client Selection ends it).
    'client_selection_declined',
    'client_selection_withdrawn',
  ],
} as const;

export function isValidDispositionReason(
  authority: PipelineDispositionAuthority,
  reason: string,
): boolean {
  return (PIPELINE_DISPOSITION_REASONS[authority] as readonly string[]).includes(
    reason,
  );
}

// The closed set of every legal (authority, reason) pair — for a caller that
// wants to enumerate the taxonomy.
export function isRecruiterDispositionAuthority(
  authority: PipelineDispositionAuthority,
): boolean {
  return (RECRUITER_DISPOSITION_AUTHORITIES as readonly string[]).includes(
    authority,
  );
}
