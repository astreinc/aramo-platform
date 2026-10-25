import { ApiError } from '@aramo/fe-foundation';

import type { ChangeRequestDetail } from './commercial-api';
import { chainName, refusalVerdict, type VerdictContext } from './commercial-model';

// CCP-B1 — change-request route errors → the drawer's refusal alert (CCP-UI v1.0
// handoff §3.2, §5.2 item 3: "Approval refused. {message} (409 {CODE})"). Every
// refusal is the A3 engine's answer; the copy explains it, it never overrides it.

export interface RefusalCopy {
  /** The bold lead ("Approval refused."). */
  readonly lead: string;
  readonly message: string;
  /** "409 CCP_NOT_BOOTSTRAPPED" — shown in mono. */
  readonly code: string;
  /** True for 409 CCP_NOT_BOOTSTRAPPED (feeds the bootstrap banner). */
  readonly bootstrap: boolean;
  /** The engine's refusal, for COMMERCIAL_APPROVAL_REFUSED. */
  readonly refusal: string | null;
}

const GENERIC = 'Something went wrong. Try again in a minute.';

/**
 * An approve / reject / submit / withdraw failure. `act` names the lead:
 * "Approval refused." · "Rejection refused." · "Not submitted." · "Not withdrawn."
 */
export function refusalCopy(err: unknown, detail: ChangeRequestDetail, ctx: VerdictContext, act: 'approve' | 'reject' | 'submit' | 'withdraw'): RefusalCopy {
  const lead = { approve: 'Approval refused.', reject: 'Rejection refused.', submit: 'Not submitted.', withdraw: 'Not withdrawn.' }[act];
  if (!(err instanceof ApiError)) return { lead, message: GENERIC, code: 'NETWORK_ERROR', bootstrap: false, refusal: null };
  const code = err.code ?? `HTTP_${err.status}`;
  const status = `${err.status} ${code}`;
  const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : null;
  if (code === 'CCP_NOT_BOOTSTRAPPED') {
    return {
      lead,
      message: `The ${chainName(detail.request)} chain doesn’t have enough distinct eligible approvers yet.`,
      code: status,
      bootstrap: true,
      refusal: null,
    };
  }
  if (code === 'COMMERCIAL_APPROVAL_REFUSED') {
    const refusal = typeof err.details?.['refusal'] === 'string' ? (err.details['refusal'] as string) : 'STEP_SCOPE_MISSING';
    const v = refusalVerdict(refusal, detail, ctx);
    return { lead, message: `${v.label}. ${v.why}`, code: `${status} · ${refusal}`, bootstrap: false, refusal };
  }
  if (code === 'COMMERCIAL_CHANGE_REQUEST_CONFLICT') {
    const message =
      reason === 'state_invalid'
        ? 'This request changed since you opened it. It has been reloaded.'
        : reason === 'integrity'
          ? 'This request failed its integrity check and can’t be signed. Contact platform engineering.'
          : 'This request changed since you opened it. It has been reloaded.';
    return { lead, message, code: reason ? `${status} · ${reason}` : status, bootstrap: false, refusal: null };
  }
  if (code === 'INSUFFICIENT_PERMISSIONS') {
    const message =
      reason === 'not_requester'
        ? 'Only the person who made this request can do this.'
        : 'Your account doesn’t have the permission for this.';
    return { lead, message, code: reason ? `${status} · ${reason}` : status, bootstrap: false, refusal: null };
  }
  if (code === 'COMMERCIAL_POLICY_UNAVAILABLE') {
    return { lead, message: 'No commercial policy is active right now, so nothing can be signed.', code: status, bootstrap: false, refusal: null };
  }
  return { lead, message: GENERIC, code: status, bootstrap: false, refusal: null };
}

/** A list / detail read failure → one line. */
export function loadErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Your account can’t read commercial change requests.';
  if (err instanceof ApiError && err.status === 404) return 'This change request doesn’t exist.';
  return 'Change requests couldn’t be loaded. Try again.';
}
