// Client Rule Consolidation C2-4 — the envelope-contract refusals (M-A2 §2.2, M-A3 §6/§7,
// M-A5 §3/§4) now live in @aramo/sign-client. Re-exported so libs/sign callers are unchanged;
// sign-service still maps each to an AramoError with a stable details.reason.
export {
  EnvelopeRevisionMismatchError,
  ReminderLimitError,
  InboxSigningRefusedError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  SessionIssueRefusedError,
  AttestedNameRequiredError,
} from '@aramo/sign-client';
export type { ReminderLimitReason, InboxSigningRefusal, SessionIssueRefusal } from '@aramo/sign-client';
