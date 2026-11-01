import type { IdentityRepository } from '@aramo/identity';
import type { MailerPort } from '@aramo/mailer';
import type { RenewalNoticeRepository } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SIGN_RENEWAL_NOTICE_INTERVAL_MS, SignRenewalNoticeRecipients, SignRenewalNoticeWorker, signRenewalNoticeInterval } from '../app/billing/sign-renewal-notice.worker.js';

// Remaining-Work Consolidated Directive (32e5e3e1) A3 — the sign-service renewal notice job: dark
// unless SIGN_RENEWAL_NOTICES_ENABLED=1, hourly when on; the recipient is the subscribing owner while
// active (else the tenant's owner); a run failure never throws out of the tick.

const ENV_KEYS = ['SIGN_RENEWAL_NOTICES_ENABLED', 'SIGN_RENEWAL_NOTICE_DAYS', 'MAILER_PROVIDER'] as const;

describe('SignRenewalNoticeWorker', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env['MAILER_PROVIDER'] = 'stub';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const store = (rows: unknown[] = []) =>
    ({
      commitmentEndDue: vi.fn(async () => rows),
      claim: vi.fn(async () => ({ kind: 'CLAIMED', delivery_id: 'd1', attempt: 1 })),
      markSent: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      markSuppressed: vi.fn(async () => undefined),
    }) as unknown as RenewalNoticeRepository;
  const recipients = { recipientFor: vi.fn(async () => ({ email: 'owner@acme.test' })) } as unknown as SignRenewalNoticeRecipients;
  const mailer = { send: vi.fn(async () => ({ message_id: 'm1' })) } as unknown as MailerPort;

  it('is not scheduled unless SIGN_RENEWAL_NOTICES_ENABLED=1', () => {
    delete process.env['SIGN_RENEWAL_NOTICES_ENABLED'];
    expect(signRenewalNoticeInterval()).toBeNull();
    const w = new SignRenewalNoticeWorker(store(), recipients, mailer);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(false);
    process.env['SIGN_RENEWAL_NOTICES_ENABLED'] = '1';
    expect(signRenewalNoticeInterval()).toBe(SIGN_RENEWAL_NOTICE_INTERVAL_MS);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(true);
    w.onApplicationShutdown();
    expect(w.scheduled).toBe(false);
  });

  it('a tick sends the due notice with the configured lead days and the Sign billing settings link', async () => {
    process.env['SIGN_RENEWAL_NOTICE_DAYS'] = '20';
    const s = store([
      { subscription_id: 's1', tenant_id: 't1', product_key: 'sign', activated_by: 'u1', tenant_kind: 'BUSINESS', plan_name: 'Business Standard', commitment_months: 12, term_end: new Date('2027-11-02T00:00:00Z'), price_minor: 1500, currency: 'USD', billing_interval: 'MONTH' },
    ]);
    const send = vi.fn(async () => ({ message_id: 'm1' }));
    const w = new SignRenewalNoticeWorker(s, recipients, { send } as unknown as MailerPort);
    const r = await w.tick(() => new Date('2027-10-20T00:00:00Z'));
    expect(r).toMatchObject({ due: 1, sent: 1 });
    expect((s.commitmentEndDue as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(20);
    expect((send.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('/sign/settings/billing');
  });

  it('a failing run logs and returns null (never throws)', async () => {
    const s = store();
    (s.commitmentEndDue as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const w = new SignRenewalNoticeWorker(s, recipients, mailer);
    await expect(w.tick()).resolves.toBeNull();
  });
});

describe('SignRenewalNoticeRecipients', () => {
  const user = (over: Record<string, unknown> = {}) => ({ id: 'u1', email: 'buyer@acme.test', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '', ...over });
  const identity = (u: unknown, member: unknown, owner: unknown) =>
    ({
      findUserById: vi.fn(async () => u),
      findMembership: vi.fn(async () => member),
      findTenantOwner: vi.fn(async () => owner),
    }) as unknown as IdentityRepository;

  it('the subscribing owner while active in the tenant', async () => {
    const r = new SignRenewalNoticeRecipients(identity(user(), { is_active: true }, { user_id: 'o', email: 'owner@acme.test' }));
    expect(await r.recipientFor({ tenant_id: 't1', activated_by: 'u1', tenant_kind: 'BUSINESS' })).toEqual({ email: 'buyer@acme.test' });
  });

  it('else the tenant owner; else nobody', async () => {
    const owner = { user_id: 'o', email: 'owner@acme.test' };
    expect(await new SignRenewalNoticeRecipients(identity(user({ is_active: false }), { is_active: true }, owner)).recipientFor({ tenant_id: 't1', activated_by: 'u1', tenant_kind: 'BUSINESS' })).toEqual({ email: 'owner@acme.test' });
    expect(await new SignRenewalNoticeRecipients(identity(user(), { is_active: false }, owner)).recipientFor({ tenant_id: 't1', activated_by: 'u1', tenant_kind: 'BUSINESS' })).toEqual({ email: 'owner@acme.test' });
    expect(await new SignRenewalNoticeRecipients(identity(null, null, owner)).recipientFor({ tenant_id: 't1', activated_by: null, tenant_kind: 'PERSONAL' })).toEqual({ email: 'owner@acme.test' });
    expect(await new SignRenewalNoticeRecipients(identity(null, null, null)).recipientFor({ tenant_id: 't1', activated_by: 'u1', tenant_kind: 'BUSINESS' })).toBeNull();
  });
});
