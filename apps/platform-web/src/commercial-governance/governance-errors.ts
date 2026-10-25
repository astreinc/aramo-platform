import { ApiError } from '@aramo/fe-foundation';

// CCP-B5 — server refusals of the governance routes → operator copy. The server is the
// authority; the console only explains (handoff §3.2, §3.3; A3 / A9 / B5 refusal codes).

const REASON_COPY: Readonly<Record<string, string>> = {
  platform_last_owner:
    'Refused: this person is the last Platform owner. Grant Platform owner to another person first.',
  requester_role_missing: 'Your roles don’t allow this request.',
  policy_draft_exists:
    'A draft policy version already exists. Edit it, or wait until it is activated.',
  policy_version_locked: 'This draft is under an open activation request and can’t be edited.',
  policy_version_not_draft: 'Only a draft can be edited. Create a new draft instead.',
  policy_value_out_of_range: 'A value is outside its allowed range.',
  policy_value_invalid: 'The policy isn’t valid with this value.',
  policy_version_changed:
    'The draft changed after you opened it. Review it again before requesting activation.',
  open_policy_request_exists: 'A policy activation request is already open.',
  open_request_exists: 'An open request already exists.',
  role_already_held: 'This person already holds that role.',
  role_not_held: 'This person doesn’t hold that role.',
  human_ref_required:
    'This person has no one-account-per-human attestation yet, so a role can’t be granted here.',
  subject_not_platform_member: 'This person isn’t an active platform admin.',
  export_too_large: 'Too many events to export at once. Narrow the filters.',
  not_human: 'Only a person with an attested account can make this request.',
};

export function governanceErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Try again.';
  if (e.code === 'PLATFORM_LAST_OWNER') return REASON_COPY['platform_last_owner'] as string;
  if (e.code === 'CCP_NOT_BOOTSTRAPPED')
    return 'The chain doesn’t have enough distinct eligible approvers yet. (409 CCP_NOT_BOOTSTRAPPED)';
  const reason = e.details?.['reason'];
  if (typeof reason === 'string' && REASON_COPY[reason] !== undefined)
    return REASON_COPY[reason] as string;
  // CCP-B5-R — the governed apply's refusals and failures carry operator copy.
  const explanation = e.details?.['explanation'];
  if (typeof explanation === 'string' && explanation.length > 0) return explanation;
  return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
}
