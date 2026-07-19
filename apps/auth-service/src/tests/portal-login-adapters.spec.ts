import { describe, expect, it, vi } from 'vitest';
import { computeEmailFingerprint } from '@aramo/common';
import type { MailerPort } from '@aramo/mailer';
import type { IdentityIndexRepository } from '@aramo/identity-index';

import { MailerEmailSenderAdapter } from '../app/auth/mailer-email-sender.adapter.js';
import { IdentityIndexEligibilityAdapter } from '../app/auth/identity-index-eligibility.adapter.js';

// Auth-Decoupling PR-2/3 §3.3 — the two Aramo-side adapters. These are the seams
// that carry the Aramo-specific coupling (mailer / identity-index / fingerprint)
// so PortalLoginService need not. ARAMO_IDENTITY_PEPPER is set by vitest.shared
// so computeEmailFingerprint works in the eligibility adapter.

describe('MailerEmailSenderAdapter — pass-through to MailerPort (R-P23-2)', () => {
  it('forwards ALL fields incl. optional text and returns the message_id', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 'ses-123' });
    const adapter = new MailerEmailSenderAdapter({ send } as unknown as MailerPort);

    const input = { to: 'x@example.com', subject: 'Subj', html: '<b>h</b>', text: 'plain' };
    const result = await adapter.send(input);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(input); // exact structural forward — no mapping
    expect(result).toEqual({ message_id: 'ses-123' });
  });

  it('forwards an HTML-only send (text omitted) unchanged', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 'ses-456' });
    const adapter = new MailerEmailSenderAdapter({ send } as unknown as MailerPort);

    const input = { to: 'y@example.com', subject: 'S', html: '<i>h</i>' };
    const result = await adapter.send(input);

    expect(send).toHaveBeenCalledWith(input);
    expect(send.mock.calls[0]![0]).not.toHaveProperty('text');
    expect(result.message_id).toBe('ses-456');
  });
});

describe('IdentityIndexEligibilityAdapter — owns the fingerprint (R-P23-3, R-P23-5)', () => {
  const CLUSTER_ID = 'cccccccc-cccc-7ccc-8ccc-ccccccccc009';

  function make(clusterRow: { id: string; created_at: Date; updated_at: Date } | null) {
    const findClusterByFingerprint = vi.fn().mockResolvedValue(clusterRow);
    const identityIndex = { findClusterByFingerprint } as unknown as IdentityIndexRepository;
    return { adapter: new IdentityIndexEligibilityAdapter(identityIndex), findClusterByFingerprint };
  }

  it('HIT: fingerprints the email, looks up, maps cluster → { subject_ref }', async () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    const { adapter, findClusterByFingerprint } = make({ id: CLUSTER_ID, created_at: now, updated_at: now });

    const out = await adapter.resolve('known@example.com');

    // The adapter computes the fingerprint itself (auth never does).
    expect(findClusterByFingerprint).toHaveBeenCalledWith(computeEmailFingerprint('known@example.com'));
    expect(out).toEqual({ subject_ref: CLUSTER_ID });
  });

  it('MISS: returns null, never throws (R-P23-5 null-on-miss)', async () => {
    const { adapter } = make(null);
    await expect(adapter.resolve('unknown@example.com')).resolves.toBeNull();
  });

  it('subject_ref is exactly the cluster id (opaque pass-through)', async () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    const { adapter } = make({ id: CLUSTER_ID, created_at: now, updated_at: now });
    const out = await adapter.resolve('known@example.com');
    expect(out?.subject_ref).toBe(CLUSTER_ID);
  });
});
