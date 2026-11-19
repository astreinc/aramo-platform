// Signer calls on the GUEST transport only (M-A2 §2.1): every request carries the
// capability token in its body via GuestSigningSession, never workspace credentials.
// Every operation is typed from openapi/sign.yaml (B-12). The guest client's typed
// post() has no path parameters, so the field fill (/fields/{fieldId}/fill) goes through
// postRaw() with its body and response typed from the generated operation.
import { isApiError } from '../../api/errors';
import { endsSigningSession, type GuestSigningSession } from '../../api/guestSigningClient';
import { refusalMessage } from '../../api/refusalMessages';
import { fillPath, type Operation, type RequestJson, type SuccessJson } from '../../api/types';
import {
  fillsToSubmit,
  markStored,
  type SigningDocument,
  type SigningField,
  type SigningState,
} from './signingMachine';

export interface Disclosure {
  readonly disclosure_version: string;
  readonly text: string;
  readonly text_sha256: string;
  readonly message: string | null;
}

export interface SignerView {
  readonly documents: SigningDocument[];
  readonly fields: SigningField[];
  readonly message: string | null;
  /**
   * Consolidated Directive v1.0 B3 — the sender allowed delegation and this recipient may
   * still hand the envelope to someone else (the server re-checks on the delegate call).
   */
  readonly canDelegate: boolean;
}

export type SigningFailure =
  /** C-21 — revoked / expired / replaced token: recovery message, never retried. */
  | 'ended'
  /** SEQUENTIAL: an earlier signer has not signed yet. */
  | 'not_your_turn'
  /** The envelope reached an end state (completed, declined, voided, expired). */
  | 'executed'
  | 'incomplete'
  /** UAT SEC-04 — the sender set an access code and this session has not entered it. */
  | 'access_code'
  /** UAT SEC-04 — five wrong access codes locked this recipient out. */
  | 'access_code_locked'
  /** UAT SEC-04 follow-up — the sender asked for a code texted to the recipient's phone. */
  | 'sms_code'
  | 'sms_locked'
  /** UAT SEC-04 follow-up — the sender asked for an identity check (photo ID / KBA). */
  | 'identity'
  | 'identity_locked'
  | 'network'
  | 'error';

export function classifySigningError(e: unknown): SigningFailure {
  if (!isApiError(e)) return 'error';
  if (e.isNetwork) return 'network';
  if (e.code === 'SIGNER_ACCESS_CODE_LOCKED') return 'access_code_locked';
  if (e.code === 'SIGNER_ACCESS_CODE_REQUIRED') return 'access_code';
  if (e.code === 'SIGNER_IDENTITY_VERIFICATION_LOCKED') return 'identity_locked';
  if (e.code === 'SIGNER_IDENTITY_VERIFICATION_REQUIRED') return 'identity';
  if (e.reason === 'recipient_verification_locked' || e.reason === 'otp_locked') return 'sms_locked';
  if (e.reason === 'recipient_verification_required') return 'sms_code';
  if (e.reason === 'signing_session_ended' || endsSigningSession(e)) return 'ended';
  if (e.is('SIGNER_NOT_YET_ELIGIBLE', 'not_your_turn')) return 'not_your_turn';
  if (e.is('ENVELOPE_ALREADY_EXECUTED', 'envelope_not_signable')) return 'executed';
  if (e.is('SIGNATURE_FIELD_INCOMPLETE')) return 'incomplete';
  return 'error';
}

export const SIGNING_COPY = {
  ended: refusalMessage({ reason: 'signing_session_ended', code: 'signing_session_ended' }),
  executed:
    'This envelope can’t be signed any more. It may have been completed, declined, voided or expired.',
  submitFailed: 'Couldn’t finish signing. Check your connection and try again.',
  incomplete: 'Complete the required fields first',
  offline: 'You’re offline. Your entries are kept on this phone — finish when you’re connected.',
} as const;

/** "Waiting for {name}" when the refusal names the earlier signer, else a generic line. */
export function waitingForCopy(e: unknown): string {
  const name =
    isApiError(e) && typeof e.details['waiting_for'] === 'string'
      ? (e.details['waiting_for'] as string)
      : null;
  return name ? `Waiting for ${name}` : 'Waiting for an earlier signer';
}

// UAT SEC-04 — the access code (Feature-Parity §1.9), the same route and copy as the web
// signer page. The server checks and counts it; the fifth wrong code locks the recipient.
export const ACCESS_CODE_COPY = {
  title: 'Enter the access code',
  body: 'The sender protected this document with an access code. They will have given it to you separately.',
  lockedTitle: 'Too many incorrect access codes',
  lockedBody:
    'For your security, this document is locked. Contact the sender if you still need to sign.',
} as const;

export function accessCodeWrongText(left: number | null): string {
  if (left === null) return 'That code isn’t right. Check it and try again.';
  return `That code isn’t right. ${left} ${left === 1 ? 'attempt' : 'attempts'} left before this document is locked.`;
}

export type AccessCodeOutcome = { kind: 'ok' } | { kind: 'incorrect'; left: number | null };

/** Submit the code. A wrong code resolves `incorrect`; a lockout or other refusal throws. */
export async function submitAccessCode(
  session: GuestSigningSession,
  code: string,
): Promise<AccessCodeOutcome> {
  try {
    await session.post('/v1/sign/signing/access-code', { access_code: code });
    return { kind: 'ok' };
  } catch (e) {
    if (isApiError(e) && e.code === 'SIGNER_ACCESS_CODE_REQUIRED') {
      const left = e.details['attempts_remaining'];
      return {
        kind: 'incorrect',
        left: typeof left === 'number' && Number.isInteger(left) && left >= 0 ? left : null,
      };
    }
    throw e;
  }
}

// UAT SEC-04 follow-up — the SMS code (Feature-Parity §1.9), the same routes and copy as
// the web signer page. The server sends, checks and counts the code; nothing is kept here.
export const SMS_CODE_COPY = {
  title: 'Enter the code we text you',
  body: (phone: string | null) =>
    `The sender asked us to confirm your phone before you open this document. We’ll text a code to ${phone ?? 'your phone'}.`,
  lockedTitle: 'Too many incorrect codes',
  lockedBody:
    'For your security this document is locked. Contact the sender if you still need to sign.',
} as const;

const SMS_SEND_REFUSALS: Record<string, string> = {
  otp_resend_cooldown: 'Wait a minute before asking for another code.',
  otp_daily_limit:
    'You have asked for too many codes today. Try again tomorrow, or contact the sender.',
  otp_opted_out: 'This number has stopped text messages from Aramo Sign. Contact the sender.',
};
const SMS_VERIFY_REFUSALS: Record<string, string> = {
  otp_mismatch: 'That code isn’t right. Check it and try again.',
  otp_expired: 'This code has expired. Send a new one.',
  otp_code_locked: 'Too many incorrect codes. Send a new code.',
  otp_not_requested: 'Send a code first.',
};

/** The masked phone the code goes to (null when not known). */
export async function smsCodePhone(session: GuestSigningSession): Promise<string | null> {
  const r = await session.post('/v1/sign/signing/verification', {});
  return typeof r.phone === 'string' ? r.phone : null;
}

export type SmsOutcome =
  | { kind: 'verified' }
  | { kind: 'sent'; phone: string | null }
  | { kind: 'locked' }
  | { kind: 'message'; text: string };

export async function sendSmsCode(session: GuestSigningSession): Promise<SmsOutcome> {
  try {
    const r = await session.post('/v1/sign/signing/verification/sms-otp/send', {});
    if (r.verified === true) return { kind: 'verified' };
    return { kind: 'sent', phone: typeof r.phone === 'string' ? r.phone : null };
  } catch (e) {
    if (isApiError(e) && e.reason === 'otp_locked') return { kind: 'locked' };
    if (isApiError(e) && e.isNetwork) return { kind: 'message', text: SIGNING_COPY.submitFailed };
    const text = isApiError(e) ? SMS_SEND_REFUSALS[e.reason] : undefined;
    return { kind: 'message', text: text ?? 'The code couldn’t be sent. Try again in a moment.' };
  }
}

export async function verifySmsCode(session: GuestSigningSession, code: string): Promise<SmsOutcome> {
  try {
    await session.post('/v1/sign/signing/verification/sms-otp/verify', { code: code.trim() });
    return { kind: 'verified' };
  } catch (e) {
    if (isApiError(e) && e.reason === 'otp_locked') return { kind: 'locked' };
    if (isApiError(e) && e.isNetwork) return { kind: 'message', text: SIGNING_COPY.submitFailed };
    const text = isApiError(e) ? SMS_VERIFY_REFUSALS[e.reason] : undefined;
    return { kind: 'message', text: text ?? 'That didn’t go through. Try again.' };
  }
}

// UAT SEC-04 follow-up — the identity check (Feature-Parity §1.9). The check itself runs on
// the verification partner's page (opened in the browser); the app only starts it and
// reads its state. Same copy as the web signer page.
export const IDENTITY_COPY = {
  eyebrow: 'Identity check',
  title: 'Verify your identity to open this document',
  body: 'The sender asked you to confirm who you are with a photo ID. Our verification partner checks the ID; Aramo Sign keeps only the result, never the ID itself.',
  lockedTitle: 'We couldn’t verify your identity',
  lockedBody: 'The sender has been told and may send you a new request.',
  inBrowser: 'Finish the check in the browser, then come back and tap Continue.',
  processing: 'Your check is being processed. Tap Continue in a moment.',
  unavailable: 'Identity checks are not available right now. Try again later.',
  pending:
    'Your check is not finished yet. Complete it in the browser, or wait a moment and try again.',
  start: 'Start the identity check to continue.',
} as const;

export type IdentityOutcome =
  | { kind: 'verified' }
  | { kind: 'locked' }
  | { kind: 'open'; url: string }
  | { kind: 'message'; text: string };

export async function startIdentityCheck(session: GuestSigningSession): Promise<IdentityOutcome> {
  try {
    const r = await session.post('/v1/sign/signing/identity-verification/start', {});
    if (r.state === 'VERIFIED') return { kind: 'verified' };
    if (r.state === 'LOCKED') return { kind: 'locked' };
    const url = (r as { verification_url?: unknown }).verification_url;
    if (typeof url === 'string' && url.startsWith('https://')) return { kind: 'open', url };
    return { kind: 'message', text: IDENTITY_COPY.processing };
  } catch (e) {
    if (isApiError(e) && e.code === 'ESIGN_IDENTITY_VERIFICATION_UNAVAILABLE')
      return { kind: 'message', text: IDENTITY_COPY.unavailable };
    throw e;
  }
}

export async function identityCheckStatus(session: GuestSigningSession): Promise<IdentityOutcome> {
  const r = await session.post('/v1/sign/signing/identity-verification/status', {});
  if (r.state === 'VERIFIED' || r.state === 'NOT_REQUIRED') return { kind: 'verified' };
  if (r.state === 'LOCKED') return { kind: 'locked' };
  if (r.state === 'PENDING') return { kind: 'message', text: IDENTITY_COPY.pending };
  const failure = typeof r.last_failure === 'string' ? r.last_failure : null;
  return {
    kind: 'message',
    text:
      failure !== null
        ? `That check did not pass (${failure.replace(/_/g, ' ')}). ${r.attempts_remaining ?? 0} attempt(s) left.`
        : IDENTITY_COPY.start,
  };
}

/** Exchange the token (marks the signer VIEWED) and read the current disclosure. */
export async function openSigning(session: GuestSigningSession): Promise<Disclosure> {
  await session.post('/v1/sign/signing/exchange', {});
  const d = await session.post('/v1/sign/signing/disclosure-text', {});
  return {
    disclosure_version: d.disclosure_version,
    text: d.text,
    text_sha256: d.text_sha256,
    message: d.message ?? null,
  };
}

/**
 * Accept the exact disclosure version + hash shown, then load the signer's own view. A
 * hosted (in-person) session also sends the name the signer typed to confirm who they
 * are (M-A5 §3.4: `attested_name`, required by the server for HOSTED sessions only).
 */
export async function acceptAndLoad(
  session: GuestSigningSession,
  d: Disclosure,
  attestedName?: string,
): Promise<SignerView> {
  const name = attestedName?.trim();
  await session.post('/v1/sign/signing/disclosure', {
    disclosure_version: d.disclosure_version,
    disclosure_text_hash: d.text_sha256,
    ...(name ? { attested_name: name } : {}),
  });
  const v = await session.post('/v1/sign/signing/document', {});
  return {
    documents: (v.documents ?? []).map((x) => ({
      document_id: x.document_id ?? '',
      title: x.title ?? 'Document',
      ordinal: x.ordinal ?? 0,
    })),
    fields: (v.fields ?? []) as SigningField[],
    message: v.message ?? null,
    canDelegate: v.can_delegate === true,
  };
}

export async function loadSource(
  session: GuestSigningSession,
  documentId: string,
): Promise<string> {
  const r = await session.post('/v1/sign/signing/source', { document_id: documentId });
  return r.source_base64 ?? '';
}

/**
 * Finish: fill every final value, then complete (directive §6). Each successful fill is
 * marked stored so a retry after a dropped connection resends only what is missing; the
 * values themselves are never discarded on failure.
 */
const FILL_PATH = '/v1/sign/signing/fields/{fieldId}/fill' as const;
type FillOp = Operation<typeof FILL_PATH, 'post'>;
type FillBody = NonNullable<RequestJson<FillOp>>;
type FillResult = SuccessJson<FillOp>;

export async function submitSigning(
  session: GuestSigningSession,
  state: SigningState,
  onProgress: (next: SigningState) => void,
): Promise<{ envelopeStatus: string }> {
  let s = state;
  for (const f of fillsToSubmit(s)) {
    const body: Omit<FillBody, 'token'> = f.method
      ? { value: f.value, signature_method: f.method }
      : { value: f.value };
    await session.postRaw<FillResult>(
      fillPath(FILL_PATH, { fieldId: f.fieldId }) as `/v1/sign/signing/${string}`,
      body,
    );
    s = markStored(s, f.fieldId);
    onProgress(s);
  }
  const r = await session.post('/v1/sign/signing/complete', {});
  return { envelopeStatus: r?.envelope_status ?? 'IN_PROGRESS' };
}

export const DECLINE_REASON_MIN = 3;

export async function declineSigning(session: GuestSigningSession, reason: string): Promise<void> {
  await session.post('/v1/sign/signing/decline', { reason: reason.trim() });
}

export type ExecutedCopy = SuccessJson<Operation<'/v1/sign/signing/executed', 'post'>>;

/** The signed copy from a /d/ link (completion email or inbox signed-copy). */
export async function loadExecutedCopy(session: GuestSigningSession): Promise<ExecutedCopy> {
  const r = await session.post('/v1/sign/signing/executed', {});
  return r;
}

// ── B3 (Feature-Parity §1.17) — delegate signing ────────────────────────────────

export const DELEGATE_REASON_MAX = 500;
const DELEGATE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DelegateInput {
  readonly name: string;
  readonly email: string;
  readonly reason?: string;
}

/** A name and a valid email (the server checks again). */
export function validDelegate(input: DelegateInput): boolean {
  const email = input.email.trim();
  return input.name.trim().length > 0 && email.length <= 254 && DELEGATE_EMAIL_RE.test(email);
}

/**
 * Hand this signature to another person. This link stops working and the delegate is
 * emailed their own link.
 */
export async function delegateSigning(
  session: GuestSigningSession,
  input: DelegateInput,
): Promise<void> {
  const reason = input.reason?.trim().slice(0, DELEGATE_REASON_MAX);
  await session.post('/v1/sign/signing/delegate', {
    name: input.name.trim(),
    email: input.email.trim(),
    ...(reason ? { reason } : {}),
  });
}

// UAT SIG-14 (M-A7 §5.2) — "Report this envelope" from the signing screen, with the same
// public route and reasons as the web report page. One report per recipient per envelope.
export type SigningReportOutcome = 'sent' | 'already' | 'invalid' | 'limited' | 'failed';

export const SIGNING_REPORT_COPY: Record<SigningReportOutcome, string> = {
  sent: 'Thanks — we’ll look into it.',
  already: 'You’ve already reported this.',
  invalid: 'This link can’t be used to report this envelope any more.',
  limited: 'Too many reports from this connection. Try again later.',
  failed: 'Couldn’t send your report. Try again.',
};

export async function reportFromSigning(
  session: GuestSigningSession,
  reason: string | null,
  note = '',
): Promise<SigningReportOutcome> {
  try {
    // Reason and note are optional, as on the web report page.
    await session.report({ ...(reason ? { reason } : {}), ...(note ? { note } : {}) });
    return 'sent';
  } catch (e) {
    if (!isApiError(e)) return 'failed';
    if (e.status === 409) return 'already';
    if (e.status === 404 || e.status === 410 || e.status === 400) return 'invalid';
    if (e.status === 429) return 'limited';
    return 'failed';
  }
}

export const DELEGATE_COPY = {
  invalid: 'Enter a name and a valid email.',
  onEnvelope: 'That person is already on this document.',
  refused: 'This document can’t be handed off now.',
  failed: 'Couldn’t send. Check your connection and try again.',
} as const;

/** The message for a refused hand-off, or null when the refusal ends the session. */
export function delegateRefusalCopy(e: unknown): string | null {
  if (!isApiError(e) || e.isNetwork) return DELEGATE_COPY.failed;
  if (e.reason === 'delegate_invalid') return DELEGATE_COPY.invalid;
  if (e.reason === 'delegate_email_on_envelope') return DELEGATE_COPY.onEnvelope;
  if (e.status === 409 || e.status === 403) return DELEGATE_COPY.refused;
  if (e.status === 400) return DELEGATE_COPY.invalid;
  return classifySigningError(e) === 'ended' ? null : DELEGATE_COPY.failed;
}

export function delegatedCopy(name: string): string {
  return `Sent to ${name.trim()}. This link no longer works for you.`;
}
