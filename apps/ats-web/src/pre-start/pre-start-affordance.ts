import type { PreStartRequirementView } from './types';

// L5-P7 — the governed onboarding affordances for a requirement, gated by
// (status × satisfaction_policy × scope). COSMETIC: each fires an action the
// container POSTs to the guarded pre-start surface; the BE scope guards + domain
// floors (VERIFICATION_REQUIRED refuses :act SATISFY, NOT_WAIVABLE refuses waive,
// the status transition matrix) are the real authority. This mirrors the offer /
// placement affordance pattern (deterministic, prop-driven, no BE re-derivation).

export type RequirementAction = 'SATISFY' | 'VERIFY' | 'FAIL' | 'WAIVE' | 'REOPEN';

export interface RequirementAffordance {
  readonly action: RequirementAction;
  readonly label: string;
}

const ACT = 'pre_start_requirement:act';
const VERIFY = 'pre_start_requirement:verify';
const WAIVE_BLOCKING = 'pre_start_requirement:waive_blocking';
const WAIVE_ADVISORY = 'pre_start_requirement:waive_advisory';
const REOPEN = 'pre_start_requirement:reopen';

const ACTIVE = new Set(['PENDING', 'IN_PROGRESS']); // still being worked
const UNRESOLVED = new Set(['PENDING', 'IN_PROGRESS', 'FAILED']); // holds the placement
const RESOLVED = new Set(['SATISFIED', 'WAIVED', 'CANCELED']);

export function requirementActionsFor(
  r: Pick<PreStartRequirementView, 'status' | 'blocking' | 'satisfaction_policy'>,
  scopes: readonly string[],
): RequirementAffordance[] {
  const has = (s: string): boolean => scopes.includes(s);
  const out: RequirementAffordance[] = [];

  // Satisfy vs Verify — the completion-vs-verification split (L5-P6).
  if (ACTIVE.has(r.status)) {
    if (r.satisfaction_policy === 'VERIFICATION_REQUIRED') {
      if (has(VERIFY)) out.push({ action: 'VERIFY', label: 'Verify' });
    } else if (has(ACT)) {
      out.push({ action: 'SATISFY', label: 'Satisfy' });
    }
    if (has(ACT)) out.push({ action: 'FAIL', label: 'Fail' });
  }

  // Waive — an unresolved requirement, gated by blocking vs advisory authority.
  if (UNRESOLVED.has(r.status) && has(r.blocking ? WAIVE_BLOCKING : WAIVE_ADVISORY)) {
    out.push({ action: 'WAIVE', label: 'Waive' });
  }

  // Reopen — a privileged return of a resolved/failed requirement to PENDING.
  if ((RESOLVED.has(r.status) || r.status === 'FAILED') && has(REOPEN)) {
    out.push({ action: 'REOPEN', label: 'Reopen' });
  }

  return out;
}

// Mark-ready is offered only when the BE-derived assessment says ready AND the caller
// can act. The BE gate is the authority; this hides an affordance that would 409.
export function canMarkReady(
  data: { materialized: boolean; ready: boolean },
  scopes: readonly string[],
): boolean {
  return data.materialized && data.ready && scopes.includes(ACT);
}
