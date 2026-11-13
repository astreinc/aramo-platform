import { createHmac } from 'node:crypto';

import type { IdentityRepository } from '@aramo/identity';
import {
  BillingProviderUnavailableError,
  RazorpayBillingProvider,
  StaticBillingGatewayRegistry,
  StripeBillingProvider,
  type BillingWebhookInboxService,
  type SubscriptionLifecycleService,
} from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EsignBillingController } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// India Billing Regions + Razorpay (Implementation Directive v1.0 LOCKED §4.7, §6 G-4) — the Razorpay
// webhook route: 404 while dark (flag not exactly '1', or no registry); 401 when the
// X-Razorpay-Signature is missing, wrong or the body was tampered with; a verified event goes through
// the inbox as RAZORPAY with the X-Razorpay-Event-Id, activates the subscribing owner, and a
// processing failure is still a 5xx (Razorpay redelivers).

const SECRET = 'whsec_rzp_unit';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

describe('India Billing — POST /v1/sign/billing/webhook/razorpay', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_unit';
    process.env['RAZORPAY_KEY_SECRET'] = 'sec_unit';
    process.env['RAZORPAY_WEBHOOK_SECRET'] = SECRET;
    process.env['SIGN_RAZORPAY_BILLING_ENABLED'] = '1';
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const body = JSON.stringify({ entity: 'event', event: 'subscription.activated', contains: ['subscription'], payload: { subscription: { entity: { id: 'sub_rzp_1', status: 'active' } } }, created_at: 1_800_000_000 });
  const req = (b: string | undefined) => ({ rawBody: b === undefined ? undefined : Buffer.from(b) }) as never;

  function setup(receive: BillingWebhookInboxService['receive'] = async () => ({ outcome: 'APPLIED', tenant_id: 't-1', activated_owner_user_id: 'u-owner' }), registry: StaticBillingGatewayRegistry | undefined = undefined) {
    const stripe = new StripeBillingProvider();
    const reg = registry ?? new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe }, RAZORPAY: { billing: new RazorpayBillingProvider() } });
    const lifecycle = { handleEvent: vi.fn() } as unknown as SubscriptionLifecycleService;
    const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
    const inbox = { receive: vi.fn(receive) } as unknown as BillingWebhookInboxService;
    const controller = new EsignBillingController(lifecycle, stripe, owners, {} as SenderContextService, {} as IdentityRepository, undefined, inbox, undefined, undefined, undefined, undefined, undefined, reg);
    return { controller, lifecycle, owners, inbox };
  }

  it('dark: 404 unless SIGN_RAZORPAY_BILLING_ENABLED is exactly 1, and 404 with no registry bound — nothing reaches the inbox', async () => {
    for (const v of [undefined, '', '0', 'true', ' 1']) {
      if (v === undefined) delete process.env['SIGN_RAZORPAY_BILLING_ENABLED'];
      else process.env['SIGN_RAZORPAY_BILLING_ENABLED'] = v;
      const h = setup();
      await expect(h.controller.razorpayWebhook(req(body), sign(body), 'evt_1', 'r')).rejects.toMatchObject({ statusCode: 404 });
      expect(h.inbox.receive).not.toHaveBeenCalled();
    }
    process.env['SIGN_RAZORPAY_BILLING_ENABLED'] = '1';
    const unbound = new EsignBillingController({} as never, new StripeBillingProvider(), {} as never, {} as SenderContextService, {} as IdentityRepository);
    await expect(unbound.razorpayWebhook(req(body), sign(body), 'evt_1', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('enabled: a verified event goes through the inbox as RAZORPAY (with the header event id) and activates the subscribing owner', async () => {
    const h = setup();
    expect(await h.controller.razorpayWebhook(req(body), sign(body), 'evt_hdr_1', 'r')).toEqual({ received: true, outcome: 'APPLIED' });
    expect(h.inbox.receive).toHaveBeenCalledWith(expect.objectContaining({ provider: 'RAZORPAY', id: 'evt_hdr_1', type: 'subscription.activated', subscription_ref: 'sub_rzp_1' }), 'sign');
    expect(h.lifecycle.handleEvent).not.toHaveBeenCalled();
    expect(h.owners.activate).toHaveBeenCalledWith('t-1', 'u-owner', 'r');
  });

  it('not authentic → 401 and nothing recorded: missing, wrong, tampered body, no raw body, no secret', async () => {
    const h = setup();
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { statusCode?: number }) => e.statusCode);
    expect(await code(h.controller.razorpayWebhook(req(body), undefined, 'e', 'r'))).toBe(401);
    expect(await code(h.controller.razorpayWebhook(req(body), 'deadbeef', 'e', 'r'))).toBe(401);
    expect(await code(h.controller.razorpayWebhook(req(body), createHmac('sha256', 'other').update(body).digest('hex'), 'e', 'r'))).toBe(401);
    expect(await code(h.controller.razorpayWebhook(req(body.replace('sub_rzp_1', 'sub_rzp_X')), sign(body), 'e', 'r'))).toBe(401);
    expect(await code(h.controller.razorpayWebhook(req(undefined), sign(body), 'e', 'r'))).toBe(401);
    process.env['RAZORPAY_WEBHOOK_SECRET'] = '';
    expect(await code(h.controller.razorpayWebhook(req(body), sign(body), 'e', 'r'))).toBe(401);
    expect(h.inbox.receive).not.toHaveBeenCalled();
  });

  it('a processing failure is a 5xx (Razorpay redelivers)', async () => {
    const h = setup(async () => {
      throw new BillingProviderUnavailableError('down');
    });
    await expect(h.controller.razorpayWebhook(req(body), sign(body), 'e', 'r')).rejects.toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503 });
  });

  it('the Stripe webhook is unchanged (it never reaches Razorpay)', async () => {
    const h = setup();
    await expect(h.controller.stripeWebhook(req(body), sign(body), 'r')).rejects.toMatchObject({ statusCode: 401 });
    expect(h.inbox.receive).not.toHaveBeenCalled();
  });
});
