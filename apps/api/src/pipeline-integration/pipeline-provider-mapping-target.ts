import { AramoError } from '@aramo/common';
import {
  RECRUITER_DISPOSITION_AUTHORITIES,
  PIPELINE_DISPOSITION_REASONS,
  type PipelineDispositionAuthority,
  type PipelineStatus,
} from '@aramo/pipeline';

// L2-I (D1) — the canonical PROVIDER-MAPPABLE target vocabulary (R2). apps/api owns the
// @aramo/pipeline vocabulary (SB-7 keeps it out of libs/integration), so author-time
// validation of a provider mapping target lives HERE.
//
// Recruiting-Journey Evidence-Governed Milestones (L2I convergence ruling) — the provider
// vocabulary is DECOUPLED from RECRUITER_ACTION_TO_STATUS and expresses EVIDENCE SEMANTICS,
// not recruiter actions. A provider observation is provider-VERIFIED evidence, so the two
// evidence-backed milestones are mapped as EVIDENCE targets (translated to the canonical
// evidence commands by the orchestrator), never the retired naked CONTACT / MARK_RESPONDED
// recruiter actions:
//   - CONTACT_EVIDENCE  → `contacted`        (recordContactEvidence)
//   - RESPONSE_EVIDENCE → `talent_responded` (recordResponseEvidence)
// The recruiter DECISION edges a provider may still drive remain plain actions
// (START_QUALIFICATION / QUALIFY → applyAction). Plus NON-system disposition REASONS
// (RECRUITER / TALENT / ENGAGEMENT). System-only COMPLETE and ALL DOWNSTREAM_OUTCOME reasons
// stay excluded — a provider observation can never cross the authority partition.

// Evidence-semantic provider targets → the evidence-backed milestone they ground.
export const PROVIDER_EVIDENCE_TARGETS = {
  CONTACT_EVIDENCE: 'contacted',
  RESPONSE_EVIDENCE: 'talent_responded',
} as const satisfies Record<string, PipelineStatus>;
export type ProviderEvidenceTarget = keyof typeof PROVIDER_EVIDENCE_TARGETS;

// Recruiter DECISION edges a provider may drive via applyAction (NOT evidence-backed).
export const PROVIDER_DECISION_ACTIONS: readonly string[] = ['START_QUALIFICATION', 'QUALIFY'];

export const PROVIDER_MAPPABLE_ACTIONS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(PROVIDER_EVIDENCE_TARGETS),
  ...PROVIDER_DECISION_ACTIONS,
]);

export const PROVIDER_MAPPABLE_REASONS: ReadonlySet<string> = new Set(
  RECRUITER_DISPOSITION_AUTHORITIES.flatMap((authority) => [
    ...PIPELINE_DISPOSITION_REASONS[authority],
  ]),
);

// Map a provider EVIDENCE target token to the milestone it grounds (null if the token
// is not an evidence target — e.g. a decision action or reason).
export function resolveProviderEvidenceTarget(target: string): PipelineStatus | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_EVIDENCE_TARGETS, target)
    ? PROVIDER_EVIDENCE_TARGETS[target as ProviderEvidenceTarget]
    : null;
}

export type ProviderMappingTargetKind = 'action' | 'reason';

// Validate a mapping target at AUTHOR time. Returns its kind on success; throws
// PIPELINE_PROVIDER_MAPPING_TARGET_INVALID (422) for a non-canonical / system-only /
// DOWNSTREAM_OUTCOME target (mirrors the requisition reconciler's action-validity gate).
export function resolveCanonicalMappingTargetKind(
  target: string,
  requestId: string,
): ProviderMappingTargetKind {
  if (PROVIDER_MAPPABLE_ACTIONS.has(target)) return 'action';
  if (PROVIDER_MAPPABLE_REASONS.has(target)) return 'reason';
  throw new AramoError(
    'PIPELINE_PROVIDER_MAPPING_TARGET_INVALID',
    `'${target}' is not a canonical provider-mappable Pipeline action or non-system disposition reason`,
    422,
    { requestId },
  );
}

// Resolve the NON-system authority class (RECRUITER | TALENT | ENGAGEMENT) that owns a
// canonical disposition reason — the DISPOSITION command requires it. Derived from
// @aramo/pipeline (Rule D); null for a non-reason token. DOWNSTREAM_OUTCOME is never returned
// (it is not in RECRUITER_DISPOSITION_AUTHORITIES).
export function resolveReasonAuthority(reason: string): PipelineDispositionAuthority | null {
  for (const authority of RECRUITER_DISPOSITION_AUTHORITIES) {
    if ((PIPELINE_DISPOSITION_REASONS[authority] as readonly string[]).includes(reason)) {
      return authority;
    }
  }
  return null;
}
