import type { Client } from 'pg';

import { AllowanceService } from '../../lib/allowance.service.js';
import { BillingCommandService } from '../../lib/billing/billing-command.service.js';
import {
  type BillingProviderCommandPort,
  BillingProviderUnavailableError,
  type ProviderCheckoutSessionState,
  type ProviderSubscriptionState,
} from '../../lib/billing/billing-provider.port.js';
import { BillingWebhookInboxService } from '../../lib/billing/billing-webhook-inbox.service.js';
import { SubscriptionLifecycleService } from '../../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../../lib/capacity.service.js';
import type { PrismaService } from '../../lib/prisma/prisma.service.js';

import { type A6Harness, FakeBilling, a6Harness } from './ccp-a6.js';

// CCP-C1 — ONE shared harness for the C1 specs (CLAUDE.md: one shared test helper): the A6
// harness (change requests, apply, lifecycle) plus a fake Stripe that ALSO implements the command
// port, the command service and the webhook inbox, all on one Prisma client. No network, no key.
//
// The fake's NO-TRANSACTION PROBE runs on every provider call (subscription and session reads,
// cancel, expire): through a separate connection it asserts that no other backend of the test
// database has a transaction open (pg_stat_activity.xact_start) and that no command row is locked
// (FOR UPDATE NOWAIT). Any violation is recorded; the specs assert there are none.

export type ProviderFailure = { kind: 'transient' | 'refused'; times: number };

export class FakeStripe extends FakeBilling implements BillingProviderCommandPort {
  liveMode = false;
  sessions = new Map<string, ProviderCheckoutSessionState>();
  calls: { op: string; ref: string; idempotency_key?: string; at_period_end?: boolean }[] = [];
  /** Per target ref: the next N cancel / expire calls fail. */
  failures = new Map<string, ProviderFailure>();
  probes = 0;
  violations: string[] = [];
  private probeClient: Client | null = null;

  attachProbe(pg: Client | null): void {
    this.probeClient = pg;
  }

  override mode(): 'test' | 'live' {
    return this.liveMode ? 'live' : 'test';
  }

  protected async probe(op: string): Promise<void> {
    if (this.probeClient === null) return;
    this.probes += 1;
    const open = await this.probeClient.query(
      `SELECT pid, state, left(query, 120) AS q FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND xact_start IS NOT NULL`,
    );
    if (open.rows.length > 0) this.violations.push(`${op}: ${open.rows.length} backend(s) inside a transaction: ${JSON.stringify(open.rows)}`);
    await this.probeClient.query('BEGIN');
    try {
      await this.probeClient.query(`SELECT id FROM subscription."BillingProviderCommand" FOR UPDATE NOWAIT`);
    } catch (e) {
      this.violations.push(`${op}: a command row is locked during the provider call (${(e as Error).message})`);
    } finally {
      await this.probeClient.query('ROLLBACK');
    }
  }

  private failIfScheduled(ref: string): void {
    const f = this.failures.get(ref);
    if (f === undefined || f.times <= 0) return;
    f.times -= 1;
    if (f.kind === 'transient') throw new BillingProviderUnavailableError(`stripe POST ${ref}: HTTP 503`, true);
    throw new BillingProviderUnavailableError(`stripe POST ${ref}: No such object`, false);
  }

  override async retrieveSubscription(ref: string): Promise<ProviderSubscriptionState> {
    await this.probe(`retrieveSubscription ${ref}`);
    this.calls.push({ op: 'retrieveSubscription', ref });
    return super.retrieveSubscription(ref);
  }

  async cancelSubscription(subscription_ref: string, opts: { at_period_end: boolean }, idempotency_key: string): Promise<void> {
    await this.probe(`cancelSubscription ${subscription_ref}`);
    this.calls.push({ op: 'cancelSubscription', ref: subscription_ref, idempotency_key, at_period_end: opts.at_period_end });
    this.failIfScheduled(subscription_ref);
    const s = this.subs.get(subscription_ref);
    if (s === undefined) throw new BillingProviderUnavailableError('No such subscription', false);
    // The provider applies it at once; Aramo learns of it only from a webhook or a re-fetch.
    this.subs.set(subscription_ref, opts.at_period_end ? { ...s, cancel_at_period_end: true } : { ...s, provider_status: 'canceled' });
  }

  async expireCheckoutSession(session_ref: string, idempotency_key: string): Promise<void> {
    await this.probe(`expireCheckoutSession ${session_ref}`);
    this.calls.push({ op: 'expireCheckoutSession', ref: session_ref, idempotency_key });
    this.failIfScheduled(session_ref);
    const s = this.sessions.get(session_ref);
    if (s === undefined) throw new BillingProviderUnavailableError('No such checkout session', false);
    this.sessions.set(session_ref, { ...s, status: 'expired' });
  }

  async retrieveCheckoutSession(session_ref: string): Promise<ProviderCheckoutSessionState> {
    await this.probe(`retrieveCheckoutSession ${session_ref}`);
    this.calls.push({ op: 'retrieveCheckoutSession', ref: session_ref });
    const s = this.sessions.get(session_ref);
    if (s === undefined) throw new BillingProviderUnavailableError('No such checkout session', false);
    return s;
  }

  /** An open provider session for a checkout intent (`cs_<intent>`, as FakeBilling names it). */
  session(tenant_id: string, intent_id: string, status = 'open'): ProviderCheckoutSessionState {
    const s: ProviderCheckoutSessionState = { provider: 'STRIPE', session_ref: `cs_${intent_id}`, status, tenant_id, intent_id };
    this.sessions.set(s.session_ref, s);
    return s;
  }

  count(op: string, ref?: string): number {
    return this.calls.filter((c) => c.op === op && (ref === undefined || c.ref === ref)).length;
  }
}

export interface C1Harness extends Omit<A6Harness, 'billing' | 'lifecycle'> {
  billing: FakeStripe;
  lifecycle: SubscriptionLifecycleService;
  commands: BillingCommandService;
  inbox: BillingWebhookInboxService;
}

export function c1Harness(prisma: PrismaService, now: () => Date): C1Harness {
  const base = a6Harness(prisma, now);
  const billing = new FakeStripe();
  const lifecycle = new SubscriptionLifecycleService(prisma, new AllowanceService(prisma), billing, new CapacityService(prisma), undefined, undefined, base.orgProfile, billing);
  const commands = new BillingCommandService(prisma, billing, lifecycle, billing);
  const inbox = new BillingWebhookInboxService(prisma, billing, lifecycle);
  return { ...base, billing, lifecycle, commands, inbox };
}
