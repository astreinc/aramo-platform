// Pipeline & RTR Recon Remediation Directive v1.0 §2 R1 (DEF-6; Lane2-C :87) — the reasons a
// recruiter may give for Not in consideration. Hand-mirrored from libs/pipeline
// PIPELINE_DISPOSITION_REASONS for the three RECRUITER_DISPOSITION_AUTHORITIES (ats-web cannot
// import @aramo/pipeline); disposition-reasons-drift.spec.ts pins it to the backend source.
// DOWNSTREAM_OUTCOME reasons are system-owned and never offered here.
export type RecruiterDispositionAuthority = 'RECRUITER' | 'TALENT' | 'ENGAGEMENT';

export interface DispositionReasonGroup {
  readonly authority: RecruiterDispositionAuthority;
  readonly label: string;
  readonly reasons: readonly string[];
}

export const RECRUITER_DISPOSITION_REASON_GROUPS: readonly DispositionReasonGroup[] = [
  {
    authority: 'RECRUITER',
    label: 'Recruiter decision',
    reasons: ['not_a_fit', 'skills_mismatch', 'better_matched_elsewhere', 'withdrawn_by_recruiter'],
  },
  {
    authority: 'TALENT',
    label: 'Talent decision',
    reasons: ['talent_declined', 'talent_unresponsive', 'talent_accepted_other_role', 'compensation_misalignment'],
  },
  {
    authority: 'ENGAGEMENT',
    label: 'Requisition or client',
    reasons: ['requisition_closed', 'requisition_on_hold', 'client_paused_engagement', 'position_filled_externally'],
  },
];

export function authorityForReason(reason: string): RecruiterDispositionAuthority | null {
  return RECRUITER_DISPOSITION_REASON_GROUPS.find((g) => g.reasons.includes(reason))?.authority ?? null;
}
