import { ApiError } from '@aramo/fe-foundation';

// SKILL-TAX-1F-C1 — governance error → operator-legible message. Honours the B2/B3
// error contract: SKILL_CONFLICT carries details.constraint (normalized_name /
// canonical_name / normalized_alias / normalized_version / source_target_type);
// other governed refusals carry a message (+ optional details.reason). A non-ApiError
// falls back to the caller's generic message.
export function skillErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === 'SKILL_CONFLICT') {
    const constraint = e.details?.['constraint'];
    if (typeof constraint === 'string' && constraint.length > 0) {
      return `Conflict: another skill already uses that ${constraint.replace(/_/g, ' ')}.`;
    }
    return `Conflict: ${e.message}`;
  }
  if (e.code === 'SKILL_PROPOSAL_NOT_PENDING') {
    return 'This proposal is no longer pending — it was already decided. The view has been refreshed.';
  }
  const reason = e.details?.['reason'];
  const reasonSuffix = typeof reason === 'string' && reason.length > 0 ? ` (${reason})` : '';
  return `${e.message}${reasonSuffix}`;
}

// True when a governed refusal means the caller's cached state is likely stale and
// the view should reload (e.g. a 404/409 after another operator changed the skill).
export function isRefreshWorthy(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 409);
}
