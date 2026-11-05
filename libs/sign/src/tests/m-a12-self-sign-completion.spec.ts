import { describe, expect, it, vi } from 'vitest';

import { EnvelopeNotificationService } from '../lib/envelope-notification.service.js';

// Aramo-Sign-Mobile-Amendment-M-A12 (LOCKED) §2 W1-A.2 — completion delivers the executed
// copy of a SELF envelope to the caller only: its one recipient (the caller) gets the
// signed copy, and no second "completed" notice goes to the sender (the same person).

function service(envelope_mode: 'STANDARD' | 'SELF') {
  const env = {
    id: 'e1',
    tenant_id: 't1',
    subject: 'Lease',
    created_by: 'u1',
    envelope_mode,
    source_application: 'aramo-sign',
    documents: [{ source_mode: 'OWNED' }],
    signers: [{ id: 's1', name: 'Me', email: 'me@x.test', status: 'SIGNED', recipient_kind: 'SIGNER', copy_delivery: null }],
  };
  const prisma = { executedAccessGrant: { create: vi.fn(async () => ({})) }, notificationDelivery: { create: vi.fn(async () => ({})) } };
  const repo = { getEnvelopeFull: vi.fn(async () => env) };
  const notifier = { notify: vi.fn(async (_n: Record<string, unknown>) => ({ delivered: true })) };
  const senders = { findSender: vi.fn(async () => ({ email: 'me@x.test', name: 'Me' })) };
  return { svc: new EnvelopeNotificationService(prisma as never, repo as never, notifier as never, senders as never), notifier, senders };
}

describe('M-A12 — self-sign completion', () => {
  it('SELF: only the signer copy (the caller); no sender notice', async () => {
    const { svc, notifier, senders } = service('SELF');
    await svc.envelopeCompleted('t1', 'e1');
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'SIGNATURE_COMPLETED', to_email: 'me@x.test' });
    expect(notifier.notify.mock.calls[0]?.[0]).not.toHaveProperty('audience', 'SENDER');
    expect(senders.findSender).not.toHaveBeenCalled();
  });

  it('STANDARD: the signer copy and the sender notice, as before', async () => {
    const { svc, notifier } = service('STANDARD');
    await svc.envelopeCompleted('t1', 'e1');
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(notifier.notify.mock.calls[1]?.[0]).toMatchObject({ audience: 'SENDER' });
  });
});
