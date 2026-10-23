import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import {
  MailerVerificationDeliveryAdapter,
  buildVerificationConfirmLink,
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
    const adapter = new MailerVerificationDeliveryAdapter({ send }, undefined);
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

  // ATI-SEP-1 T10 WP4 — the email carries the code AND the confirm-page link
  // (INTELLIGENCE_VERIFY_LINK_BASE); the link names the verification id, never the code.
  it('EMAIL with a configured link base: the 6-digit code AND the confirm link (id only, never the code)', async () => {
    const send = vi.fn<MailerPort['send']>(async () => ({ message_id: 'm-2' }));
    const adapter = new MailerVerificationDeliveryAdapter({ send }, 'https://app.aramo.ai/');
    await expect(adapter.deliver(MESSAGE)).resolves.toEqual({ status: 'SENT' });
    const mail = send.mock.calls[0]?.[0];
    const link = `https://app.aramo.ai/email-verifications/confirm?verification_id=${MESSAGE.verification_id}`;
    expect(mail?.text).toContain('482913');
    expect(mail?.text).toContain(link);
    expect(mail?.html).toContain('482913');
    expect(mail?.html).toContain(`href="${link}"`);
    expect(link).not.toContain('482913');
  });

  it('no / invalid link base → code-only email (no link)', async () => {
    for (const base of [undefined, '', '   ', 'not a url', 'javascript:alert(1)', 'ftp://x.example']) {
      const send = vi.fn<MailerPort['send']>(async () => ({ message_id: 'm-3' }));
      await new MailerVerificationDeliveryAdapter({ send }, base).deliver(MESSAGE);
      const mail = send.mock.calls[0]?.[0];
      expect(mail?.text).toContain('482913');
      expect(mail?.text).not.toContain('email-verifications/confirm');
      expect(mail?.html).not.toContain('href=');
    }
  });

  it('buildVerificationConfirmLink: trailing slashes trimmed, id URL-encoded, http(s) only', () => {
    expect(buildVerificationConfirmLink('https://acme.aramo.ai//', 'abc')).toBe('https://acme.aramo.ai/email-verifications/confirm?verification_id=abc');
    expect(buildVerificationConfirmLink('http://localhost:4200', 'a b&c')).toBe('http://localhost:4200/email-verifications/confirm?verification_id=a+b%26c');
    expect(buildVerificationConfirmLink(null, 'abc')).toBeNull();
    expect(buildVerificationConfirmLink('mailto:x@y', 'abc')).toBeNull();
  });
});
