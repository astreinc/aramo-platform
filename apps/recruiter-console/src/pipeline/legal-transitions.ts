// LEGAL_TRANSITIONS — hand-mirrored from libs/pipeline/src/lib/pipeline-
// state.ts (the BE source of truth). Q4 ruling: hand-mirror (importing
// @aramo/pipeline is a forbidden domain edge; a BE endpoint is a
// backend change R1 halts on). Drift is caught by the structural
// deep-equal smoke spec in ./legal-transitions-drift.spec.ts — it
// reads the BE source as text, regex-extracts LEGAL_TRANSITIONS,
// normalizes both sides into Record<status, Set<status>>, and asserts
// matrix equality. Any edge added/removed/changed fails the spec.

import type { PipelineStatus } from './types';

export const LEGAL_TRANSITIONS: Record<
  PipelineStatus,
  readonly PipelineStatus[]
> = {
  no_status: ['no_contact', 'contacted', 'not_in_consideration'],
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],
  contacted: ['talent_responded', 'no_contact', 'not_in_consideration'],
  talent_responded: ['qualifying', 'contacted', 'not_in_consideration'],
  qualifying: ['submitted', 'talent_responded', 'not_in_consideration'],
  submitted: [
    'interviewing',
    'qualifying',
    'not_in_consideration',
    'client_declined',
  ],
  interviewing: [
    'offered',
    'submitted',
    'not_in_consideration',
    'client_declined',
  ],
  offered: [
    'placed',
    'interviewing',
    'not_in_consideration',
    'client_declined',
  ],
  not_in_consideration: [],
  client_declined: [],
  placed: [],
};

// legalNextStates — the UI affordance helper. Returns the set of
// statuses the recruiter is permitted to choose from `from`. The
// "Move to…" Popover renders ONLY these as options.
export function legalNextStates(
  from: PipelineStatus,
): readonly PipelineStatus[] {
  return LEGAL_TRANSITIONS[from];
}
