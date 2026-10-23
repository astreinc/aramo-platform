import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import {
  MailerVerificationDeliveryAdapter,
  mailerConfigured,
  renderVerificationCodeEmail,
  selectVerificationDelivery,
} from '../lib/verification/mailer-verification-delivery.js';
import { LogVerificationDeliveryAdapter } from '../lib/verification/verification-delivery.js';

// ATI-SEP-1 T8 — the real verification delivery adapter (@aramo/mailer).

const MESSAGE = {
  verification_id: '0190ffff-0000-7000-8000-000000000001',
  channel: 'EMAIL' as const,
  destination: 'ada@example.com',
  code: '482913',
  expires_at: new Date(Date.now() + 600_000),
};

describe('ATI-SEP-1 T8 — MailerVerificationDeliveryAdapter', () => {
  it('EMAIL: sends the code through the mailer port to the destination → SENT', async () => {
    const send = vi.fn<MailerPort['send']>(async () => ({ message_id: 'm-1' }));
    const adapter = new MailerVerificationDeliveryAdapter({ send });
    await expect(adapter.deliver(MESSAGE)).resolves.toEqual({ status: 'SENT' });
    const mail = send.mock.calls[0]?.[0];
    expect(mail?.to).toBe('ada@example.com');
    expect(mail?.text).toContain('482913');
    expect(mail?.html).toContain('482913');
    expect(mail?.subject).not.toContain('482913');
  });

  it('a mailer failure is transient (RETRY), and the code never reaches a log line', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new MailerVerificationDeliveryAdapter({ send: async () => Promise.reject(new Error('SES throttled 482913')) });
    await expect(adapter.deliver(MESSAGE)).resolves.toEqual({ status: 'RETRY', error: 'MAILER_FAILED' });
    for (const call of log.mock.calls) expect(String(call)).not.toContain('482913');
    log.mockRestore();
  });

  it('SMS stays NOT_AVAILABLE (on hold) and nothing is sent', async () => {
    const send = vi.fn<MailerPort['send']>();
    const adapter = new MailerVerificationDeliveryAdapter({ send });
    expect(adapter.isAvailable('SMS')).toBe(false);
    await expect(adapter.deliver({ ...MESSAGE, channel: 'SMS', destination: '+15550001111' })).resolves.toEqual({ status: 'NOT_AVAILABLE' });
    expect(send).not.toHaveBeenCalled();
  });

  it('binding: a configured mailer → the mailer adapter; none → the LOG adapter', () => {
    expect(selectVerificationDelivery({ send: async () => ({ message_id: 'x' }) })).toBeInstanceOf(MailerVerificationDeliveryAdapter);
    expect(selectVerificationDelivery(undefined)).toBeInstanceOf(LogVerificationDeliveryAdapter);
    expect(mailerConfigured({ MAILER_PROVIDER: 'ses' })).toBe(true);
    expect(mailerConfigured({ MAILER_PROVIDER: ' ' })).toBe(false);
    expect(mailerConfigured({})).toBe(false);
  });

  it('the rendered email carries only digits of the code (no markup injection)', () => {
    const r = renderVerificationCodeEmail({ code: '12<b>34', expires_at: new Date(Date.now() + 60_000) });
    expect(r.html).toContain('1234');
    expect(r.html).not.toContain('<b>34');
  });
});
