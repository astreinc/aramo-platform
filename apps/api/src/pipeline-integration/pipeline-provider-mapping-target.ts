import { AramoError } from '@aramo/common';
import {
  RECRUITER_ACTION_TO_STATUS,
  RECRUITER_DISPOSITION_AUTHORITIES,
  PIPELINE_DISPOSITION_REASONS,
  type PipelineDispositionAuthority,
} from '@aramo/pipeline';

// L2-I (D1) — the canonical PROVIDER-MAPPABLE target vocabulary (R2, PO ruling). apps/api
// is the layer that owns the @aramo/pipeline vocabulary (SB-7 keeps it out of libs/integration),
// so author-time validation of a provider mapping target lives HERE. The allowed set is
// DERIVED from the pipeline domain (Rule D — never restated as a local literal list):
//   - recruiter named ACTIONS  (RECRUITER_ACTION_TO_STATUS keys)
//   - NON-system disposition REASONS (RECRUITER / TALENT / ENGAGEMENT authority classes)
// System-only COMPLETE (absent from RECRUITER_ACTION_TO_STATUS) and ALL DOWNSTREAM_OUTCOME
// reasons are DELIBERATELY EXCLUDED — an external provider observation can never cross the
// authority partition (pipeline-disposition RECRUITER_DISPOSITION_AUTHORITIES).

export const PROVIDER_MAPPABLE_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys(RECRUITER_ACTION_TO_STATUS),
);

export const PROVIDER_MAPPABLE_REASONS: ReadonlySet<string> = new Set(
  RECRUITER_DISPOSITION_AUTHORITIES.flatMap((authority) => [
    ...PIPELINE_DISPOSITION_REASONS[authority],
  ]),
);

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
