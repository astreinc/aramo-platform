import { describe, expect, it, vi } from 'vitest';

import {
  RENEWAL_NOTICE_DEFAULT_DAYS,
  RenewalNoticeService,
  billingSettingsUrl,
  renderRenewalNotice,
  renewalNoticeLeadDays,
  renewalNoticeTemplateSha256,
  renewalNoticesEnabled,
  type RenewalNoticeClaim,
  type RenewalNoticeDue,
  type RenewalNoticeStore,
} from '../lib/billing/renewal-notice.js';

// Remaining-Work Consolidated Directive (32e5e3e1) A3 — the Aramo renewal notice: the settings (dark
// by default, lead time 30 days), the wording (the commitment end, month to month at the monthly
// price, how and when to cancel), and one run's outcomes per claim (sent, suppressed, failed, in doubt).

const TERM_END = new Date('2027-11-02T00:00:00.000Z');

function due(over: Partial<RenewalNoticeDue> = {}): RenewalNoticeDue {
  return {
    subscription_id: 's1',
    tenant_id: 't1',
    product_key: 'sign',
    activated_by: 'u1',
    tenant_kind: 'BUSINESS',
    plan_name: 'Business Standard',
    commitment_months: 12,
    term_end: TERM_END,
    price_minor: 1500,
    currency: 'USD',
    billing_interval: 'MONTH',
    ...over,
  };
}

class FakeStore implements RenewalNoticeStore {
  claims: RenewalNoticeClaim[] = [];
  marks: string[] = [];
  constructor(private readonly rows: RenewalNoticeDue[]) {}
  async commitmentEndDue() {
    return this.rows;
  }
  async claim() {
    return this.claims.shift() ?? { kind: 'CLAIMED' as const, delivery_id: 'd1', attempt: 1 };
  }
  async markSent(id: string, provider: string, message_id: string) {
    this.marks.push(`SENT ${id} ${provider} ${message_id}`);
  }
  async markFailed(id: string, provider: string, code: string) {
    this.marks.push(`FAILED ${id} ${provider} ${code}`);
  }
  async markSuppressed(id: string, code: string) {
    this.marks.push(`SUPPRESSED ${id} ${code}`);
  }
}

function service(store: RenewalNoticeStore, opts: { email?: string | null; send?: () => Promise<{ message_id: string }>; lookup?: () => Promise<{ email: string } | null> } = {}) {
  const send = vi.fn(async (_mail: { to: string; subject: string; html: string; text?: string }) => (opts.send !== undefined ? opts.send() : { message_id: 'm1' }));
  const email = opts.email === undefined ? 'owner@acme.test' : opts.email;
  return {
    send,
    svc: new RenewalNoticeService({
      store,
      recipients: { recipientFor: opts.lookup ?? (async () => (email === null ? null : { email })) },
      mailer: { send },
      provider: 'stub',
      settings_base_url: 'https://sign.aramo.ai/',
      lead_days: 30,
      now: () => new Date('2027-10-10T00:00:00.000Z'),
    }),
  };
}

describe('Remaining-Work A3 — renewal notice settings', () => {
  it('dark unless SIGN_RENEWAL_NOTICES_ENABLED=1; lead days 1 to 90, default 30', () => {
    expect(renewalNoticesEnabled({})).toBe(false);
    expect(renewalNoticesEnabled({ SIGN_RENEWAL_NOTICES_ENABLED: 'true' })).toBe(false);
    expect(renewalNoticesEnabled({ SIGN_RENEWAL_NOTICES_ENABLED: '1' })).toBe(true);
    expect(renewalNoticeLeadDays({})).toBe(RENEWAL_NOTICE_DEFAULT_DAYS);
    expect(RENEWAL_NOTICE_DEFAULT_DAYS).toBe(30);
    expect(renewalNoticeLeadDays({ SIGN_RENEWAL_NOTICE_DAYS: '45' })).toBe(45);
    for (const bad of ['0', '91', '7.5', 'x', ' ']) expect(renewalNoticeLeadDays({ SIGN_RENEWAL_NOTICE_DAYS: bad })).toBe(30);
  });

  it('the billing settings link is the workspace of the tenant kind', () => {
    expect(billingSettingsUrl('https://sign.aramo.ai/', 'BUSINESS')).toBe('https://sign.aramo.ai/sign/settings/billing');
    expect(billingSettingsUrl('https://sign.aramo.ai', 'PERSONAL')).toBe('https://sign.aramo.ai/personal/settings/billing');
  });
});

describe('Remaining-Work A3 — renewal notice wording', () => {
  it('Business: the date, month to month at the monthly price, how and when to cancel', () => {
    const r = renderRenewalNotice({ plan_name: 'Business Standard', commitment_months: 12, term_end: TERM_END, price_minor: 1500, currency: 'USD', personal: false, billing_settings_url: 'https://sign.aramo.ai/sign/settings/billing' });
    expect(r.subject).toBe('Your Aramo Sign commitment ends on November 2, 2027');
    expect(r.text).toBe(
      [
        'The 12-month commitment of your Aramo Sign Business Standard subscription ends on November 2, 2027.',
        'After that date your subscription continues month to month at $15.00 per month, plus applicable tax, until you cancel. If you do nothing, it continues and you are charged each month.',
        'You can cancel online in your billing settings during the last month of your commitment; your subscription then ends on November 2, 2027. After that date, a cancellation takes effect at the end of the current monthly billing period.',
        'Billing settings: https://sign.aramo.ai/sign/settings/billing',
        'Aramo Sign',
      ].join('\n\n'),
    );
    expect(r.html).toContain('<a href="https://sign.aramo.ai/sign/settings/billing">Open your billing settings</a>');
    expect(r.text).not.toContain('Free plan');
  });

  it('Personal: adds the return to the Free plan; plan names are escaped in HTML', () => {
    const r = renderRenewalNotice({ plan_name: 'Standard <b>', commitment_months: 12, term_end: TERM_END, price_minor: 1000, currency: 'USD', personal: true, billing_settings_url: 'https://x/personal/settings/billing' });
    expect(r.text).toContain('When your subscription ends, your account returns to the Free plan.');
    expect(r.html).toContain('Standard &lt;b&gt;');
    expect(r.html).not.toContain('<b>');
  });

  it('the template hash is stable', () => {
    expect(renewalNoticeTemplateSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(renewalNoticeTemplateSha256()).toBe(renewalNoticeTemplateSha256());
  });
});

describe('Remaining-Work A3 — one run', () => {
  it('sends one email to the recipient and records it SENT', async () => {
    const store = new FakeStore([due()]);
    const { svc, send } = service(store);
    expect(await svc.run()).toEqual({ due: 1, sent: 1, failed: 0, suppressed: 0, already_done: 0, in_doubt: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ to: 'owner@acme.test', subject: 'Your Aramo Sign commitment ends on November 2, 2027' });
    expect(store.marks).toEqual(['SENT d1 stub m1']);
  });

  it('skips what is done or in doubt; never sends twice', async () => {
    const store = new FakeStore([due(), due({ subscription_id: 's2' }), due({ subscription_id: 's3' })]);
    store.claims = [{ kind: 'ALREADY_DONE' }, { kind: 'IN_DOUBT' }, { kind: 'EXHAUSTED' }];
    const { svc, send } = service(store);
    expect(await svc.run()).toMatchObject({ due: 3, sent: 0, already_done: 2, in_doubt: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses a plan without a monthly list price, and a missing or invalid address', async () => {
    const store = new FakeStore([due({ price_minor: null }), due({ billing_interval: 'YEAR' }), due(), due()]);
    const lookups = [null, { email: 'not-an-address' }];
    const { svc, send } = service(store, { lookup: async () => lookups.shift() ?? null });
    expect(await svc.run()).toMatchObject({ suppressed: 4, sent: 0 });
    expect(store.marks).toEqual(['SUPPRESSED d1 not_monthly_priced', 'SUPPRESSED d1 not_monthly_priced', 'SUPPRESSED d1 no_recipient', 'SUPPRESSED d1 invalid_address']);
    expect(send).not.toHaveBeenCalled();
  });

  it('a refused send or a failed recipient lookup is FAILED (retried later); an accepted send without an id stays in doubt', async () => {
    const store = new FakeStore([due(), due(), due()]);
    let n = 0;
    const { svc } = service(store, {
      lookup: async () => {
        n++;
        if (n === 2) throw Object.assign(new Error('db down'), { name: 'PrismaClientKnownRequestError' });
        return { email: 'owner@acme.test' };
      },
      send: async () => {
        if (n === 1) throw Object.assign(new Error('x'), { name: 'Throttling' });
        return { message_id: '' };
      },
    });
    expect(await svc.run()).toMatchObject({ failed: 2, in_doubt: 1, sent: 0 });
    expect(store.marks).toEqual(['FAILED d1 stub Throttling', 'FAILED d1 stub recipient_PrismaClientKnownRequestError']);
  });
});
