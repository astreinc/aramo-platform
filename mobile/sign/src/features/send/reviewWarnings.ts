// "Before you send" (handoff §4.6 Review; directive §5): the blocking warnings the
// backend enforces at send — no document, no signing recipient, a signing recipient
// without a SIGNATURE field, a copy recipient WITH fields or without a timing (M-A5
// §1.5, §2.1; sender-envelope.service.ts readiness) — plus the Personal limit and any
// refusal the backend returned for the last attempt, rendered by reason code. Copy
// recipients never sign, so they never need a signature field.
import type { ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { LimitBanner } from '../inbox/allowance';
import type { SendDraftPayload } from './draftModel';
import { copyRecipients, signingRecipients } from './recipientRoles';

export type WarningKind =
  | 'no_document'
  | 'no_signer'
  | 'no_signature_field'
  | 'copy_with_fields'
  | 'copy_timing'
  | 'limit'
  | 'refusal';

export interface ReviewWarning {
  readonly kind: WarningKind;
  readonly text: string;
}

/** Reasons a send refusal can carry that the app explains with its own copy. */
const SEND_REFUSAL_COPY: Record<string, string> = {
  not_ready: 'This envelope isn’t ready to send yet.',
  personal_sending_not_enabled: 'Sending isn’t available for this account yet.',
  personal_restricted: 'Sending is turned off for this account.',
  personal_location_not_supported: 'Sending isn’t available where you are.',
  ESIGN_NOT_SUBSCRIBED: 'Your organization needs an Aramo Sign plan to send.',
  ESIGN_ALLOWANCE_EXHAUSTED: 'Your plan’s sending allowance is used up.',
  INSUFFICIENT_PERMISSIONS: 'You don’t have permission to send envelopes.',
};

const GENERIC = refusalMessage({ reason: '', code: '' });

/** The reason decides first (ours, then the shared copy); the code is the fallback. */
export function refusalText(error: Pick<ApiError, 'reason' | 'code'>): string {
  const own = SEND_REFUSAL_COPY[error.reason];
  if (own) return own;
  const shared = refusalMessage({ reason: error.reason, code: '' });
  if (shared !== GENERIC) return shared;
  return SEND_REFUSAL_COPY[error.code] ?? refusalMessage(error);
}

export function reviewWarnings(
  p: Pick<SendDraftPayload, 'documents' | 'recipients' | 'fields'>,
  limit: LimitBanner | null,
  refusal: Pick<ApiError, 'reason' | 'code'> | null,
): ReviewWarning[] {
  const out: ReviewWarning[] = [];
  if (p.documents.length === 0) out.push({ kind: 'no_document', text: 'Add a document.' });
  const signing = signingRecipients(p.recipients);
  if (signing.length === 0) out.push({ kind: 'no_signer', text: 'Add at least one signer.' });
  for (const r of signing) {
    if (!p.fields.some((f) => f.recipientKey === r.key && f.type === 'SIGNATURE')) {
      out.push({
        kind: 'no_signature_field',
        text: `${r.name || r.email} has no signature field.`,
      });
    }
  }
  for (const r of copyRecipients(p.recipients)) {
    const who = r.name || r.email;
    if (p.fields.some((f) => f.recipientKey === r.key)) {
      out.push({
        kind: 'copy_with_fields',
        text: `${who} receives a copy and can’t have fields. Open Fields to remove them.`,
      });
    }
    if (!r.copyDelivery) {
      out.push({ kind: 'copy_timing', text: `Choose when ${who} receives a copy.` });
    }
  }
  if (limit) out.push({ kind: 'limit', text: limit.body });
  // A refusal already explained by a local warning isn't repeated.
  if (refusal && !(refusal.reason === 'not_ready' && out.length > 0)) {
    out.push({ kind: 'refusal', text: refusalText(refusal) });
  }
  return out;
}
