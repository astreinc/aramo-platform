import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import { MailerEmailSenderAdapter } from '../app/auth/mailer-email-sender.adapter.js';
import { PortalDeferredEligibilityAdapter } from '../app/auth/portal-deferred-eligibility.adapter.js';

// Auth-Decoupling PR-2/3 §3.3 — the Aramo-side adapters. These are the seams
// that carry the Aramo-specific coupling so PortalLoginService need not.
// ATI-SEP-1 T10 WP4 (Addendum A4, GAP-PORTAL-ID-1) — the eligibility adapter is
// the portal-deferred one (the retired identity index is gone).

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

describe('PortalDeferredEligibilityAdapter — A4 / GAP-PORTAL-ID-1', () => {
  it('returns null (no eligibility) for every address, never throws', async () => {
    const adapter = new PortalDeferredEligibilityAdapter();
    await expect(adapter.resolve('known@example.com')).resolves.toBeNull();
    await expect(adapter.resolve('unknown@example.com')).resolves.toBeNull();
    await expect(adapter.resolve('')).resolves.toBeNull();
  });
});
