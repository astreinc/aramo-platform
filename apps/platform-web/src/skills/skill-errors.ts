import { ApiError } from '@aramo/fe-foundation';

// PLATFORM-UX-1 F-7 — governance refusals → plain operator copy (handoff §9
// "Skills errors"). The code stays visible in parentheses, as the design shows
// it ("… (SKILL_CONFLICT)"), so support can match it.

const CONFLICT_COPY: Readonly<Record<string, string>> = {
  normalized_name: 'A skill with this name already exists.',
  canonical_name: 'A skill with this name already exists.',
  normalized_alias: 'That alias is already in use.',
  normalized_version: 'That version already exists on this skill.',
  source_target_type: 'That relationship already exists.',
};

export const PAYLOAD_INVALID_COPY =
  'This proposal can’t be applied: the change it describes is incomplete or no longer valid. Reject it instead.';

export function skillErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === 'SKILL_CONFLICT') {
    const constraint = e.details?.['constraint'];
    const copy =
      typeof constraint === 'string' && CONFLICT_COPY[constraint] !== undefined
        ? CONFLICT_COPY[constraint]
        : 'This change conflicts with an existing skill, alias, version or relationship.';
    return `${copy} (SKILL_CONFLICT)`;
  }
  if (e.code === 'SKILL_PROPOSAL_PAYLOAD_INVALID') {
    return `${PAYLOAD_INVALID_COPY} (SKILL_PROPOSAL_PAYLOAD_INVALID)`;
  }
  if (e.code === 'SKILL_PROPOSAL_NOT_PENDING') {
    return notPendingMessage(null);
  }
  const reason = e.details?.['reason'];
  const reasonSuffix = typeof reason === 'string' && reason.length > 0 ? ` (${reason})` : '';
  return `${e.message}${reasonSuffix}`;
}

/** True for the 409 that means another operator already decided the proposal. */
export function isNotPending(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'SKILL_PROPOSAL_NOT_PENDING';
}

/**
 * The design's warning alert copy (handoff §9 Proposals). `decided` is the
 * refreshed status when known, so the sentence names what actually happened.
 */
export function notPendingMessage(decided: string | null): string {
  const what = decided === 'ACCEPTED' ? 'accepted' : decided === 'REJECTED' ? 'rejected' : 'decided';
  return `This proposal is no longer pending — it was ${what} by another operator a moment ago. The list has been refreshed. (SKILL_PROPOSAL_NOT_PENDING)`;
}
