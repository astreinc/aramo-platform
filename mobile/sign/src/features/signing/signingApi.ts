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
}

export type SigningFailure =
  /** C-21 — revoked / expired / replaced token: recovery message, never retried. */
  | 'ended'
  /** SEQUENTIAL: an earlier signer has not signed yet. */
  | 'not_your_turn'
  /** The envelope reached an end state (completed, declined, voided, expired). */
  | 'executed'
  | 'incomplete'
  | 'network'
  | 'error';

export function classifySigningError(e: unknown): SigningFailure {
  if (!isApiError(e)) return 'error';
  if (e.isNetwork) return 'network';
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

/** Accept the exact disclosure version + hash shown, then load the signer's own view. */
export async function acceptAndLoad(
  session: GuestSigningSession,
  d: Disclosure,
): Promise<SignerView> {
  await session.post('/v1/sign/signing/disclosure', {
    disclosure_version: d.disclosure_version,
    disclosure_text_hash: d.text_sha256,
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
