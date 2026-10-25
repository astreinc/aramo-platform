import { createHmac } from 'node:crypto';

import type { IdentityRepository } from '@aramo/identity';
import { BillingProviderUnavailableError, StripeBillingProvider, type BillingCommandService, type BillingWebhookInboxService, type SubscriptionLifecycleService } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EsignBillingCommandWorker, billingCommandWorkerInterval } from '../app/billing/esign-billing-command.worker.js';
import { EsignBillingController } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// CCP-C1 — the sign-service side of the Stripe command outbox and webhook inbox: the webhook route
// records every verified event in the inbox (and still answers 5xx on a failure so the provider
// redelivers); the command worker is OFF by default and, when on, dispatches, re-fetches and
// drains in one tick, activating a subscribing owner the way the webhook route does. Test IDs are
// cited by doc/ccp/slices/CCP-C1-acceptance.md.

const SECRET = 'whsec_unit';
const signed = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
};

describe('CCP-C1 webhook route → inbox', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const body = JSON.stringify({ id: 'evt_c1', type: 'checkout.session.completed', created: 1, data: { object: { mode: 'subscription', subscription: 'sub_1' } } });
  const req = (b: string) => ({ rawBody: Buffer.from(b) }) as never;
  function setup(receive: BillingWebhookInboxService['receive']) {
    const lifecycle = { handleEvent: vi.fn() } as unknown as SubscriptionLifecycleService;
    const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
    const inbox = { receive: vi.fn(receive) } as unknown as BillingWebhookInboxService;
    const controller = new EsignBillingController(lifecycle, new StripeBillingProvider(), owners, {} as SenderContextService, {} as IdentityRepository, undefined, inbox);
    return { controller, lifecycle, owners, inbox };
  }

  it('C1-S-1 a verified event goes through the inbox (never straight to the lifecycle) and activates the subscribing owner', async () => {
    const { controller, lifecycle, owners, inbox } = setup(async () => ({ outcome: 'APPLIED', tenant_id: 't-1', activated_owner_user_id: 'u-owner' }));
    expect(await controller.stripeWebhook(req(body), signed(body), 'r')).toEqual({ received: true, outcome: 'APPLIED' });
    expect(inbox.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_c1', subscription_ref: 'sub_1' }), 'sign');
    expect(lifecycle.handleEvent).not.toHaveBeenCalled();
    expect(owners.activate).toHaveBeenCalledWith('t-1', 'u-owner', 'r');
  });

  it('C1-S-2 an inbox processing failure is still a 5xx (the provider redelivers); a forged event never reaches the inbox', async () => {
    const down = setup(async () => {
      throw new BillingProviderUnavailableError('down');
    });
    await expect(down.controller.stripeWebhook(req(body), signed(body), 'r')).rejects.toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503 });
    const forged = setup(async () => ({ outcome: 'APPLIED', tenant_id: 't-1' }));
    await expect(forged.controller.stripeWebhook(req(body), 't=1,v1=deadbeef', 'r')).rejects.toMatchObject({ statusCode: 401 });
    expect(forged.inbox.receive).not.toHaveBeenCalled();
  });
});

describe('CCP-C1 EsignBillingCommandWorker', () => {
  it('C1-S-3 OFF by default: no interval unless SIGN_BILLING_COMMANDS_ENABLED=1; the interval floor is 10 s', () => {
    expect(billingCommandWorkerInterval({})).toBeNull();
    expect(billingCommandWorkerInterval({ SIGN_BILLING_COMMANDS_ENABLED: '0' })).toBeNull();
    expect(billingCommandWorkerInterval({ SIGN_BILLING_COMMANDS_ENABLED: 'true' })).toBeNull();
    expect(billingCommandWorkerInterval({ SIGN_BILLING_COMMANDS_ENABLED: '1' })).toBe(60_000);
    expect(billingCommandWorkerInterval({ SIGN_BILLING_COMMANDS_ENABLED: '1', SIGN_BILLING_COMMANDS_INTERVAL_MS: '30000' })).toBe(30_000);
    expect(billingCommandWorkerInterval({ SIGN_BILLING_COMMANDS_ENABLED: '1', SIGN_BILLING_COMMANDS_INTERVAL_MS: '5' })).toBe(60_000);
  });

  it('C1-S-4 not started on bootstrap without the flag', () => {
    const saved = process.env['SIGN_BILLING_COMMANDS_ENABLED'];
    delete process.env['SIGN_BILLING_COMMANDS_ENABLED'];
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    try {
      new EsignBillingCommandWorker({} as BillingCommandService, {} as BillingWebhookInboxService, {} as EsignOwnerActivationService).onApplicationBootstrap();
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
      if (saved !== undefined) process.env['SIGN_BILLING_COMMANDS_ENABLED'] = saved;
    }
  });

  it('C1-S-5 a tick dispatches, re-fetches pending commands and drains the inbox; an opened sending subscription activates its owner; a failing tick never throws', async () => {
    const at = new Date('2026-10-26T12:00:00.000Z');
    const commands = {
      dispatchDue: vi.fn(async () => ({ skipped: null, claimed: 2, accepted: 1, retry_wait: 1, failed: 0, lost_fence: 0 })),
      reconcilePending: vi.fn(async () => ({ checked: 1, confirmed: 1, failed: 0, results: [{ outcome: 'APPLIED', tenant_id: 't-1', detail: 'ACTIVE -> CANCELED' }] })),
    } as unknown as BillingCommandService;
    const inbox = { drain: vi.fn(async () => ({ claimed: 1, processed: 1, failed: 0, results: [{ outcome: 'APPLIED', tenant_id: 't-2', activated_owner_user_id: 'u-2' }] })) } as unknown as BillingWebhookInboxService;
    const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
    const w = new EsignBillingCommandWorker(commands, inbox, owners);
    expect(await w.tick(at)).toEqual({ dispatched: 2, reconciled: 1, drained: 1 });
    expect(commands.dispatchDue).toHaveBeenCalledWith(at);
    expect(commands.reconcilePending).toHaveBeenCalledWith('sign', at);
    expect(inbox.drain).toHaveBeenCalledWith('sign', at);
    expect(owners.activate).toHaveBeenCalledTimes(1);
    expect(owners.activate).toHaveBeenCalledWith('t-2', 'u-2', 'billing-commands');
    const broken = new EsignBillingCommandWorker({ dispatchDue: vi.fn(async () => { throw new Error('db down'); }) } as unknown as BillingCommandService, inbox, owners);
    expect(await broken.tick(at)).toEqual({ dispatched: 0, reconciled: 0, drained: 0 });
  });
});
