// Client Rule Consolidation C2-5 — runs under vitest and mobile Jest (globals only).
// The envelope-contract refusals: each carries a stable name and reason.
import {
  AttestedNameRequiredError,
  EnvelopeRevisionMismatchError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  InboxSigningRefusedError,
  ReminderLimitError,
  SessionIssueRefusedError,
} from '../index.js';

describe('envelope contract refusals', () => {
  const retryAt = new Date('2026-11-21T10:00:00Z');
  it.each([
    ['EnvelopeRevisionMismatchError', new EnvelopeRevisionMismatchError('e1', 3, 2), 'SignatureEnvelope e1 is at revision 3, not 2'],
    ['ReminderLimitError', new ReminderLimitError('reminder_cooldown', retryAt), 'reminder refused (reminder_cooldown); retry at 2026-11-21T10:00:00.000Z'],
    ['InboxSigningRefusedError', new InboxSigningRefusedError('not_your_turn'), 'inbox signing refused: not_your_turn'],
    ['IdempotencyKeyReuseError', new IdempotencyKeyReuseError(), 'Idempotency-Key was already used with a different request'],
    ['IdempotencyRequestInProgressError', new IdempotencyRequestInProgressError(), 'A request with this Idempotency-Key is still in progress'],
    ['SessionIssueRefusedError', new SessionIssueRefusedError('email_not_verified'), 'signing session not issued: email_not_verified'],
    ['AttestedNameRequiredError', new AttestedNameRequiredError(), 'attested_name is required to accept the disclosure in a hosted session'],
  ])('%s', (name, error, message) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).toBe(message);
  });

  it('keeps the reason fields the server maps to details.reason', () => {
    expect(new InboxSigningRefusedError('link_expired').reason).toBe('link_expired');
    expect(new SessionIssueRefusedError('signer_not_found').reason).toBe('signer_not_found');
    expect(new ReminderLimitError('reminder_daily_limit', retryAt).retryAt).toBe(retryAt);
  });
});
