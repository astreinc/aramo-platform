import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { planVersionTerms } from '../plan-version.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Aramo Sign Remaining-Work Consolidated Directive v1.0 (LOCKED, 32e5e3e1) Workstream A3 — the Aramo
// renewal notice. For each open self-service subscription that continues automatically after a term
// boundary, one email to the subscribing owner a set number of days before that boundary.
//
// The model in force (ToS v2.0 B5.1, Lead Q4 ruling): a subscription starts with a 12-month
// commitment billed monthly and then continues month to month until cancelled; a cancellation takes
// effect at the end of the current monthly billing period. So the one boundary with something to tell
// the Subscriber is the commitment end (notice kind COMMITMENT_END): the plan continues month to month,
// at the monthly price, cancellable in the billing settings. A later annual-term schedule (A2, gated on
// a Lead ruling) adds a notice kind for each term end; the claim, the evidence table and the sender are
// shared, so only the selection and the wording change.
//
// DARK: nothing runs unless SIGN_RENEWAL_NOTICES_ENABLED=1 (the sign-service worker). The lead time is
// SIGN_RENEWAL_NOTICE_DAYS (default 30). Evidence: subscription."RenewalNoticeDelivery" (migration
// 20261102100000_sign_renewal_notice), one row per (subscription, kind, term end, channel); a claim is
// an INSERT … ON CONFLICT DO NOTHING, so a re-run or a second process never sends twice. A FAILED send
// is retried on a later run (up to RENEWAL_NOTICE_MAX_ATTEMPTS); a PENDING row whose send outcome was
// never recorded stays in doubt and is never resent automatically. No address or body is stored.

export const RENEWAL_NOTICE_KINDS = ['COMMITMENT_END'] as const;
export type RenewalNoticeKind = (typeof RENEWAL_NOTICE_KINDS)[number];

export const RENEWAL_NOTICE_DEFAULT_DAYS = 30;
export const RENEWAL_NOTICE_MAX_DAYS = 90;
export const RENEWAL_NOTICE_MAX_ATTEMPTS = 5;
export const RENEWAL_NOTICE_BATCH = 200;

/** SIGN_RENEWAL_NOTICES_ENABLED=1 turns the job on (off by default). */
export function renewalNoticesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_RENEWAL_NOTICES_ENABLED'] === '1';
}

/** SIGN_RENEWAL_NOTICE_DAYS — whole days before the term end, 1 to 90 (anything else: the default 30). */
export function renewalNoticeLeadDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['SIGN_RENEWAL_NOTICE_DAYS'];
  if (raw === undefined || raw.trim() === '') return RENEWAL_NOTICE_DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= RENEWAL_NOTICE_MAX_DAYS ? n : RENEWAL_NOTICE_DEFAULT_DAYS;
}

// ── Template ──────────────────────────────────────────────────────────────────────────────────────

export const RENEWAL_NOTICE_TEMPLATE = { id: 'sign.renewal_notice.commitment_end', version: '1.0' } as const;

export interface RenewalNoticeContent {
  plan_name: string;
  commitment_months: number | null;
  term_end: Date;
  price_minor: number;
  currency: string;
  personal: boolean;
  billing_settings_url: string;
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function priceText(amount_minor: number, currency: string): string {
  const v = (amount_minor / 100).toFixed(2);
  return currency.toUpperCase() === 'USD' ? `$${v}` : `${v} ${currency.toUpperCase()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The commitment-end notice: the date, the month-to-month continuation and price, how and when to cancel. */
export function renewalNoticeParagraphs(c: RenewalNoticeContent): { subject: string; paragraphs: string[]; link: string } {
  const date = longDate(c.term_end);
  const price = priceText(c.price_minor, c.currency);
  const term = c.commitment_months !== null ? `${c.commitment_months}-month commitment` : 'commitment';
  return {
    subject: `Your Aramo Sign commitment ends on ${date}`,
    paragraphs: [
      `The ${term} of your Aramo Sign ${c.plan_name} subscription ends on ${date}.`,
      `After that date your subscription continues month to month at ${price} per month, plus applicable tax, until you cancel. If you do nothing, it continues and you are charged each month.`,
      `You can cancel online in your billing settings during the last month of your commitment; your subscription then ends on ${date}. After that date, a cancellation takes effect at the end of the current monthly billing period.`,
      ...(c.personal ? ['When your subscription ends, your account returns to the Free plan.'] : []),
    ],
    link: c.billing_settings_url,
  };
}

export function renderRenewalNotice(c: RenewalNoticeContent): { subject: string; text: string; html: string } {
  const p = renewalNoticeParagraphs(c);
  const text = [...p.paragraphs, `Billing settings: ${p.link}`, 'Aramo Sign'].join('\n\n');
  const html = [
    ...p.paragraphs.map((x) => `<p>${escapeHtml(x)}</p>`),
    `<p><a href="${escapeHtml(p.link)}">Open your billing settings</a></p>`,
    '<p>Aramo Sign</p>',
  ].join('\n');
  return { subject: p.subject, text, html };
}

/** The SHA-256 of the template's fixed wording (a sample render), recorded with each delivery. */
export function renewalNoticeTemplateSha256(): string {
  const sample = (personal: boolean) =>
    renderRenewalNotice({ plan_name: '{plan}', commitment_months: 12, term_end: new Date(Date.UTC(2000, 0, 1)), price_minor: 0, currency: 'USD', personal, billing_settings_url: '{link}' });
  const body = JSON.stringify([RENEWAL_NOTICE_TEMPLATE, sample(false), sample(true)]);
  return createHash('sha256').update(body).digest('hex');
}

// ── Ports ─────────────────────────────────────────────────────────────────────────────────────────

/** Structurally the @aramo/mailer MailerPort (this lib does not depend on the mailer lib). */
export interface RenewalNoticeMailer {
  send(args: { to: string; subject: string; html: string; text?: string }): Promise<{ message_id: string }>;
}

/** Who receives the notice: the subscribing owner (bound in the product service). */
export interface RenewalNoticeRecipientPort {
  recipientFor(args: { tenant_id: string; activated_by: string | null; tenant_kind: string }): Promise<{ email: string } | null>;
}

// ── Evidence store ────────────────────────────────────────────────────────────────────────────────

export interface RenewalNoticeDue {
  subscription_id: string;
  tenant_id: string;
  product_key: string;
  activated_by: string | null;
  tenant_kind: string;
  plan_name: string;
  commitment_months: number | null;
  term_end: Date;
  price_minor: number | null;
  currency: string | null;
  billing_interval: string | null;
}

export type RenewalNoticeClaim = { kind: 'CLAIMED'; delivery_id: string; attempt: number } | { kind: 'ALREADY_DONE' } | { kind: 'IN_DOUBT' } | { kind: 'EXHAUSTED' };

export interface RenewalNoticeIdentity {
  subscription_id: string;
  tenant_id: string;
  product_key: string;
  notice_kind: RenewalNoticeKind;
  term_end: Date;
  lead_days: number;
  template_sha256: string;
}

@Injectable()
export class RenewalNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * COMMITMENT_END notices due: open, provider-billed SELF_SERVICE rows that are not set to cancel,
   * whose commitment ends after `now` and no later than `now + lead_days`. Oldest boundary first.
   */
  async commitmentEndDue(now: Date, lead_days: number, limit = RENEWAL_NOTICE_BATCH): Promise<RenewalNoticeDue[]> {
    const horizon = new Date(now.getTime() + lead_days * 86_400_000);
    const rows = await this.prisma.tenantSubscription.findMany({
      where: {
        ended_at: null,
        source: 'SELF_SERVICE',
        billing_provider: { not: null },
        billing_subscription_ref: { not: null },
        cancel_at_period_end: false,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        commitment_end: { gt: now, lte: horizon },
      },
      include: { plan: { select: { name: true, tenant_kind: true } }, plan_version: { select: { id: true, content: true, content_checksum: true } } },
      orderBy: [{ commitment_end: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((r) => {
      const terms = planVersionTerms(r.plan_version).plan;
      return {
        subscription_id: r.id,
        tenant_id: r.tenant_id,
        product_key: r.product_key,
        activated_by: r.activated_by,
        tenant_kind: terms.tenant_kind ?? r.plan.tenant_kind ?? 'BUSINESS',
        plan_name: terms.name || r.plan.name,
        commitment_months: terms.commitment_months,
        term_end: r.commitment_end as Date,
        price_minor: terms.list_price_minor,
        currency: terms.currency,
        billing_interval: terms.billing_interval,
      };
    });
  }

  /**
   * Claim one notice for sending:
   *   - no row          → a PENDING row is inserted (CLAIMED, attempt 1);
   *   - FAILED          → reset to PENDING (CLAIMED, attempt n+1) while attempts remain, else EXHAUSTED;
   *   - SENT/SUPPRESSED → ALREADY_DONE (never re-sent);
   *   - PENDING         → IN_DOUBT (an earlier run stopped before recording the outcome).
   */
  async claim(n: RenewalNoticeIdentity, now: Date): Promise<RenewalNoticeClaim> {
    const id = uuidv7();
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "subscription"."RenewalNoticeDelivery"
        ("id", "subscription_id", "tenant_id", "product_key", "notice_kind", "term_end", "lead_days", "channel",
         "template_id", "template_version", "template_sha256", "status", "attempt_count", "created_at", "updated_at")
      VALUES (${id}::uuid, ${n.subscription_id}::uuid, ${n.tenant_id}::uuid, ${n.product_key}, ${n.notice_kind}, ${n.term_end}, ${n.lead_days}, 'EMAIL',
              ${RENEWAL_NOTICE_TEMPLATE.id}, ${RENEWAL_NOTICE_TEMPLATE.version}, ${n.template_sha256}, 'PENDING', 1, ${now}, ${now})
      ON CONFLICT ("subscription_id", "notice_kind", "term_end", "channel") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 1) return { kind: 'CLAIMED', delivery_id: inserted[0]!.id, attempt: 1 };

    const existing = await this.prisma.renewalNoticeDelivery.findUnique({
      where: { subscription_id_notice_kind_term_end_channel: { subscription_id: n.subscription_id, notice_kind: n.notice_kind, term_end: n.term_end, channel: 'EMAIL' } },
      select: { id: true, status: true, attempt_count: true },
    });
    if (existing === null) return { kind: 'IN_DOUBT' };
    if (existing.status === 'SENT' || existing.status === 'SUPPRESSED') return { kind: 'ALREADY_DONE' };
    if (existing.status === 'PENDING') return { kind: 'IN_DOUBT' };
    if (existing.attempt_count >= RENEWAL_NOTICE_MAX_ATTEMPTS) return { kind: 'EXHAUSTED' };
    // FAILED: a conditional reset, so a concurrent run that got there first wins and this one backs off.
    const reset = await this.prisma.renewalNoticeDelivery.updateMany({
      where: { id: existing.id, status: 'FAILED', attempt_count: existing.attempt_count },
      data: { status: 'PENDING', attempt_count: existing.attempt_count + 1, error_code: null, lead_days: n.lead_days, template_version: RENEWAL_NOTICE_TEMPLATE.version, template_sha256: n.template_sha256, updated_at: now },
    });
    if (reset.count !== 1) return { kind: 'IN_DOUBT' };
    return { kind: 'CLAIMED', delivery_id: existing.id, attempt: existing.attempt_count + 1 };
  }

  async markSent(delivery_id: string, provider: string, provider_message_id: string, now: Date): Promise<void> {
    await this.prisma.renewalNoticeDelivery.update({ where: { id: delivery_id }, data: { status: 'SENT', provider, provider_message_id, sent_at: now, error_code: null, updated_at: now } });
  }

  async markFailed(delivery_id: string, provider: string, error_code: string, now: Date): Promise<void> {
    await this.prisma.renewalNoticeDelivery.update({ where: { id: delivery_id }, data: { status: 'FAILED', provider, error_code, updated_at: now } });
  }

  async markSuppressed(delivery_id: string, error_code: string, now: Date): Promise<void> {
    await this.prisma.renewalNoticeDelivery.update({ where: { id: delivery_id }, data: { status: 'SUPPRESSED', error_code, updated_at: now } });
  }
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────

export interface RenewalNoticeRunCounts {
  due: number;
  sent: number;
  failed: number;
  suppressed: number;
  already_done: number;
  in_doubt: number;
}

/** The repository surface the run needs (RenewalNoticeRepository; a fake in unit specs). */
export type RenewalNoticeStore = Pick<RenewalNoticeRepository, 'commitmentEndDue' | 'claim' | 'markSent' | 'markFailed' | 'markSuppressed'>;

export interface RenewalNoticeDeps {
  store: RenewalNoticeStore;
  recipients: RenewalNoticeRecipientPort;
  mailer: RenewalNoticeMailer;
  // ses | stub | outbox — recorded with each delivery.
  provider: string;
  // The Sign web origin (for example https://sign.aramo.ai); the billing settings path is per tenant kind.
  settings_base_url: string;
  lead_days: number;
  now?: () => Date;
}

const EMAIL_PATTERN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** The billing settings page of the tenant's workspace (where Cancel subscription is). */
export function billingSettingsUrl(base: string, tenant_kind: string): string {
  return `${base.replace(/\/+$/, '')}${tenant_kind === 'PERSONAL' ? '/personal/settings/billing' : '/sign/settings/billing'}`;
}

/** A short, non-personal error code from a send failure (never the message text). */
function errorCode(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown } | null;
  const raw = typeof e?.name === 'string' && e.name !== 'Error' ? e.name : typeof e?.Code === 'string' ? e.Code : typeof e?.code === 'string' ? e.code : 'send_failed';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'send_failed';
}

export class RenewalNoticeService {
  private readonly now: () => Date;
  private readonly sha: string;

  constructor(private readonly deps: RenewalNoticeDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sha = renewalNoticeTemplateSha256();
  }

  /** One pass over the due COMMITMENT_END notices. */
  async run(): Promise<RenewalNoticeRunCounts> {
    const at = this.now();
    const counts: RenewalNoticeRunCounts = { due: 0, sent: 0, failed: 0, suppressed: 0, already_done: 0, in_doubt: 0 };
    const due = await this.deps.store.commitmentEndDue(at, this.deps.lead_days);
    for (const c of due) {
      counts.due++;
      const claim = await this.deps.store.claim(
        { subscription_id: c.subscription_id, tenant_id: c.tenant_id, product_key: c.product_key, notice_kind: 'COMMITMENT_END', term_end: c.term_end, lead_days: this.deps.lead_days, template_sha256: this.sha },
        this.now(),
      );
      if (claim.kind === 'ALREADY_DONE' || claim.kind === 'EXHAUSTED') {
        counts.already_done++;
        continue;
      }
      if (claim.kind === 'IN_DOUBT') {
        counts.in_doubt++;
        continue;
      }
      // Only a monthly plan with a list price has approved wording (month to month at a monthly price).
      if (c.price_minor === null || c.currency === null || (c.billing_interval ?? 'MONTH').toUpperCase() !== 'MONTH') {
        await this.deps.store.markSuppressed(claim.delivery_id, 'not_monthly_priced', this.now());
        counts.suppressed++;
        continue;
      }
      let to: string | null = null;
      try {
        to = (await this.deps.recipients.recipientFor({ tenant_id: c.tenant_id, activated_by: c.activated_by, tenant_kind: c.tenant_kind }))?.email ?? null;
      } catch (err) {
        // A lookup failure is not a missing recipient: retried on a later run.
        await this.deps.store.markFailed(claim.delivery_id, this.deps.provider, `recipient_${errorCode(err)}`.slice(0, 64), this.now());
        counts.failed++;
        continue;
      }
      if (to === null || !EMAIL_PATTERN.test(to)) {
        await this.deps.store.markSuppressed(claim.delivery_id, to === null ? 'no_recipient' : 'invalid_address', this.now());
        counts.suppressed++;
        continue;
      }
      const rendered = renderRenewalNotice({
        plan_name: c.plan_name,
        commitment_months: c.commitment_months,
        term_end: c.term_end,
        price_minor: c.price_minor,
        currency: c.currency,
        personal: c.tenant_kind === 'PERSONAL',
        billing_settings_url: billingSettingsUrl(this.deps.settings_base_url, c.tenant_kind),
      });
      let message_id: unknown;
      try {
        message_id = (await this.deps.mailer.send({ to, subject: rendered.subject, html: rendered.html, text: rendered.text }))?.message_id;
      } catch (err) {
        // The provider refused it: nothing was sent, so a later run may retry it.
        await this.deps.store.markFailed(claim.delivery_id, this.deps.provider, errorCode(err), this.now());
        counts.failed++;
        continue;
      }
      if (typeof message_id !== 'string' || message_id.length === 0) {
        // Accepted without an id: it may have gone. Left PENDING (in doubt), never retried automatically.
        counts.in_doubt++;
        continue;
      }
      await this.deps.store.markSent(claim.delivery_id, this.deps.provider, message_id, this.now());
      counts.sent++;
    }
    return counts;
  }
}
