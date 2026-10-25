import { createHmac } from 'node:crypto';

import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository, IdentityService } from '@aramo/identity';
import { BillingProviderUnavailableError, BillingRefusedError, StripeBillingProvider, type SubscriptionLifecycleService } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import { EsignBillingReconcileWorker } from '../app/billing/esign-billing-reconcile.worker.js';
import { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo Sign launch — the sign-service billing surface: webhook authenticity
// (forged / unsigned refused before anything is read), subscribing-owner
// activation (governed: member + organization authority only), server-built
// checkout URLs, PERSONAL refusal, read authority, typed refusals, reconcile.

const SECRET = 'whsec_unit';
const auth = (scopes: string[], sub = 'u-owner'): AuthContextType => ({ sub, tenant_id: 't-1', scopes, consumer_type: 'sign' }) as unknown as AuthContextType;
const signed = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
};

function setup(over: Partial<Record<string, unknown>> = {}) {
  const lifecycle = {
    handleEvent: vi.fn(async () => ({ outcome: 'APPLIED', tenant_id: 't-1', activated_owner_user_id: 'u-owner' })),
    account: vi.fn(async () => ({ subscription: null, allowance: { subscribed: false, allowance_key: 'sign.envelopes', state: 'NONE' }, billing_available: true })),
    sendingOwner: vi.fn(async () => null),
    startCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.test/x' })),
    portal: vi.fn(async () => ({ url: 'https://billing.stripe.test/p' })),
    listSellablePlans: vi.fn(async () => []),
    ...over,
  } as unknown as SubscriptionLifecycleService;
  const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
  const ctx = {
    tenantKind: vi.fn(async () => 'BUSINESS'),
    tenantOf: vi.fn(async () => ({ id: 't-1', kind: 'BUSINESS', status: 'ACTIVE' })),
    personalAuthoringOpen: vi.fn(() => false),
    assertCanAuthor: vi.fn(async () => undefined),
    assertBusiness: vi.fn(async () => undefined),
  } as unknown as SenderContextService;
  const identity = { findUserById: vi.fn(async () => ({ id: 'u-owner', email: 'owner@astre.test' })) } as unknown as IdentityRepository;
  const controller = new EsignBillingController(lifecycle, new StripeBillingProvider(), owners, ctx, identity);
  return { controller, lifecycle, owners, ctx };
}

describe('EsignBillingController', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
    process.env['SIGN_SENDER_WEB_BASE_URL'] = 'https://esign.example.test/';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', created: 1, data: { object: { mode: 'subscription', subscription: 'sub_1' } } });
  const req = (b: string | undefined) => ({ rawBody: b === undefined ? undefined : Buffer.from(b) }) as never;

  it('refuses a forged, unsigned or tampered webhook with 401 before processing anything', async () => {
    const { controller, lifecycle } = setup();
    const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: AramoError) => `${e.code}:${e.statusCode}`);
    expect(await code(controller.stripeWebhook(req(body), undefined, 'r'))).toBe('AUTH_REQUIRED:401');
    expect(await code(controller.stripeWebhook(req(body), 't=1,v1=deadbeef', 'r'))).toBe('AUTH_REQUIRED:401');
    expect(await code(controller.stripeWebhook(req(body.replace('sub_1', 'sub_X')), signed(body), 'r'))).toBe('AUTH_REQUIRED:401');
    expect(await code(controller.stripeWebhook(req(undefined), signed(body), 'r'))).toBe('AUTH_REQUIRED:401');
    delete process.env['STRIPE_WEBHOOK_SECRET'];
    expect(await code(controller.stripeWebhook(req(body), signed(body), 'r'))).toBe('AUTH_REQUIRED:401');
    expect(lifecycle.handleEvent).not.toHaveBeenCalled();
  });

  it('a verified webhook is processed and activates the subscribing owner', async () => {
    const { controller, lifecycle, owners } = setup();
    expect(await controller.stripeWebhook(req(body), signed(body), 'r')).toEqual({ received: true, outcome: 'APPLIED' });
    expect(lifecycle.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1', type: 'checkout.session.completed', subscription_ref: 'sub_1' }), 'sign');
    expect(owners.activate).toHaveBeenCalledWith('t-1', 'u-owner', 'r');
  });

  it('a duplicate or ignored event activates nobody; a processing failure is a 5xx so the provider redelivers', async () => {
    const dup = setup({ handleEvent: vi.fn(async () => ({ outcome: 'DUPLICATE', tenant_id: null })) });
    expect((await dup.controller.stripeWebhook(req(body), signed(body), 'r')).outcome).toBe('DUPLICATE');
    expect(dup.owners.activate).not.toHaveBeenCalled();
    const down = setup({ handleEvent: vi.fn(async () => { throw new BillingProviderUnavailableError('down'); }) });
    await expect(down.controller.stripeWebhook(req(body), signed(body), 'r')).rejects.toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503 });
  });

  it('checkout builds the return URLs server-side and refuses a PERSONAL tenant', async () => {
    const { controller, lifecycle, ctx } = setup();
    await controller.checkout(auth(['sign:billing:manage']), 'r', { plan_key: 'aramo-sign-business-v1' });
    expect(lifecycle.startCheckout).toHaveBeenCalledWith({
      product_key: 'sign',
      tenant_id: 't-1',
      user_id: 'u-owner',
      user_email: 'owner@astre.test',
      plan_key: 'aramo-sign-business-v1',
      success_url: 'https://esign.example.test/sign/settings/billing?checkout=success',
      cancel_url: 'https://esign.example.test/sign/settings/billing?checkout=canceled',
      accept_terms: false,
    });
    (ctx.assertBusiness as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new AramoError('INSUFFICIENT_PERMISSIONS', 'personal', 403, { requestId: 'r' }));
    await expect(controller.checkout(auth(['sign:billing:manage']), 'r', { plan_key: 'aramo-sign-business-v1' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(controller.checkout(auth(['sign:billing:manage']), 'r', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ROLES-1 PR-2 (§3.4, F-3; D-3) — billing is sign:billing:manage ONLY (tenant_owner).
  it('checkout / portal refuse organization settings authority alone (the fallback is removed)', async () => {
    const { controller, lifecycle } = setup();
    await expect(controller.checkout(auth(['tenant:admin:settings']), 'r', { plan_key: 'aramo-sign-business-v1' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'billing_manage_scope_missing', missing_scopes: ['sign:billing:manage'] } },
    });
    // The organization administrator (tenant_admin: every Sign admin scope, no billing).
    await expect(
      controller.checkout(auth(['tenant:admin:settings', 'sign:envelope:read', 'sign:envelope:send', 'sign:member:manage']), 'r', { plan_key: 'aramo-sign-business-v1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(lifecycle.startCheckout).not.toHaveBeenCalled();
  });

  it('account needs Sign read or billing authority, and reports who may manage billing (ROLES-1 PR-2: owner only)', async () => {
    const { controller } = setup();
    await expect(controller.account(auth([]), 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(controller.account(auth(['tenant:admin:settings']), 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(await controller.account(auth(['sign:envelope:read']), 'r')).toMatchObject({ can_manage_billing: false, self_service_eligible: true });
    expect(await controller.account(auth(['sign:envelope:read', 'tenant:admin:settings']), 'r')).toMatchObject({ can_manage_billing: false });
    expect(await controller.account(auth(['sign:billing:manage']), 'r')).toMatchObject({ can_manage_billing: true });
  });

  it('heals a missed owner grant on the subscribing owner’s own read only', async () => {
    const { controller, owners } = setup({ sendingOwner: vi.fn(async () => 'u-owner') });
    await controller.account(auth(['sign:billing:manage'], 'someone-else'), 'r');
    expect(owners.activate).not.toHaveBeenCalled();
    await controller.account(auth(['sign:billing:manage'], 'u-owner'), 'r');
    expect(owners.activate).toHaveBeenCalledWith('t-1', 'u-owner', 'r');
  });

  it('maps every billing refusal to a typed error', () => {
    expect(billingHttpError(new BillingRefusedError('BILLING_UNAVAILABLE'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503 });
    expect(billingHttpError(new BillingRefusedError('PLAN_NOT_SELLABLE'), 'r')).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(billingHttpError(new BillingRefusedError('PORTAL_NOT_CONFIGURED'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503, context: { details: { reason: 'PORTAL_NOT_CONFIGURED' } } });
    expect(billingHttpError(new BillingRefusedError('PLAN_NOT_ELIGIBLE'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_CONFLICT', statusCode: 409 });
    expect(billingHttpError(new BillingRefusedError('TERMS_NOT_APPROVED'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_UNAVAILABLE', statusCode: 503 });
    expect(billingHttpError(new BillingRefusedError('TERMS_NOT_ACCEPTED'), 'r')).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(billingHttpError(new BillingRefusedError('ALREADY_SUBSCRIBED'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_CONFLICT', statusCode: 409, context: { details: { reason: 'ALREADY_SUBSCRIBED' } } });
    expect(billingHttpError(new BillingRefusedError('NO_BILLING_ACCOUNT'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_CONFLICT', context: { details: { reason: 'NO_BILLING_ACCOUNT' } } });
    // CCP-A6 (Conversion Rule C-4) — a new typed refusal; ALREADY_SUBSCRIBED keeps its meaning.
    expect(billingHttpError(new BillingRefusedError('GOVERNED_SUBSCRIPTION_OPEN'), 'r')).toMatchObject({ code: 'ESIGN_BILLING_CONFLICT', statusCode: 409, context: { details: { reason: 'governed_subscription_open' } } });
    expect(billingHttpError(new Error('secret detail'), 'r')).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Billing request failed' });
  });

  it('maps ORGANIZATION_PROFILE_REQUIRED to a 409 carrying the specific profile reason (Sign Signup A1 §2.6)', () => {
    const msg = 'Complete your organization’s legal name and US address in Settings before subscribing';
    expect(billingHttpError(new BillingRefusedError('ORGANIZATION_PROFILE_REQUIRED', 'organization_country_not_supported'), 'r')).toMatchObject({
      code: 'ESIGN_BILLING_CONFLICT',
      statusCode: 409,
      message: msg,
      context: { details: { reason: 'organization_country_not_supported' } },
    });
    expect(billingHttpError(new BillingRefusedError('ORGANIZATION_PROFILE_REQUIRED', 'organization_profile_incomplete'), 'r')).toMatchObject({
      code: 'ESIGN_BILLING_CONFLICT',
      statusCode: 409,
      context: { details: { reason: 'organization_profile_incomplete' } },
    });
    expect(billingHttpError(new BillingRefusedError('ORGANIZATION_PROFILE_REQUIRED'), 'r')).toMatchObject({ context: { details: { reason: 'organization_profile_incomplete' } } });
  });

  it('maps DOMAIN_VERIFICATION_REQUIRED to a 409 with reason domain_verification_required (Domain-Enforcement P3 §4)', () => {
    expect(billingHttpError(new BillingRefusedError('DOMAIN_VERIFICATION_REQUIRED'), 'r-9')).toMatchObject({
      code: 'ESIGN_BILLING_CONFLICT',
      statusCode: 409,
      message: 'Verify your organization’s email domain before subscribing. You can assign this to your IT administrator in Settings.',
      context: { requestId: 'r-9', details: { reason: 'domain_verification_required' } },
    });
  });
});

describe('EsignOwnerActivationService', () => {
  const build = (o: { member?: boolean; active?: boolean; userActive?: boolean; keys?: string[]; fail?: boolean }) => {
    const repo = {
      findMembership: vi.fn(async () => (o.member === false ? null : { id: 'm-1', is_active: o.active !== false })),
      findUserById: vi.fn(async () => ({ id: 'u', is_active: o.userActive !== false })),
    } as unknown as IdentityRepository;
    const identity = {
      findRoleKeysForMembership: vi.fn(async () => o.keys ?? ['tenant_admin']),
      resolveRoleIdsByKeys: vi.fn(async (k: string[]) => k.map((x) => `id-${x}`)),
      replaceMembershipRoles: vi.fn(async () => {
        if (o.fail) throw new Error('esign_role_not_entitled');
        return { added_role_ids: [], removed_role_ids: [] };
      }),
    } as unknown as IdentityService;
    return { svc: new EsignOwnerActivationService(repo, identity), identity };
  };

  // ROLES-1 PR-2 (§3.4; Conforming Amendment 9) — the subscribing owner is the tenant's
  // tenant_owner; no product-level owner role (sign_owner) is granted any more.
  it('the subscribing owner is tenant_owner: a tenant_admin member receives it (system authority), keeping their other roles', async () => {
    const { svc, identity } = build({ keys: ['tenant_admin'] });
    expect(await svc.activate('t', 'u', 'r')).toBe('GRANTED');
    expect(identity.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: 'm-1',
      tenant_id: 't',
      role_keys: ['tenant_admin', 'tenant_owner'],
      role_ids: ['id-tenant_admin', 'id-tenant_owner'],
      request_id: 'r',
      owner_role_authority: 'system',
    });
  });

  it('never widens anyone else, never grants sign_owner, and is idempotent', async () => {
    expect(await build({ keys: ['tenant_owner'] }).svc.activate('t', 'u', 'r')).toBe('ALREADY');
    expect(await build({ keys: ['tenant_owner', 'tenant_admin'] }).svc.activate('t', 'u', 'r')).toBe('ALREADY');
    // ats_admin / sign_admin are product roles, not organization authority.
    expect(await build({ keys: ['ats_admin'] }).svc.activate('t', 'u', 'r')).toBe('NOT_ORG_AUTHORITY');
    expect(await build({ keys: ['sign_admin'] }).svc.activate('t', 'u', 'r')).toBe('NOT_ORG_AUTHORITY');
    expect(await build({ keys: ['recruiter'] }).svc.activate('t', 'u', 'r')).toBe('NOT_ORG_AUTHORITY');
    expect(await build({ member: false }).svc.activate('t', 'u', 'r')).toBe('NOT_MEMBER');
    expect(await build({ active: false }).svc.activate('t', 'u', 'r')).toBe('NOT_MEMBER');
    expect(await build({ userActive: false }).svc.activate('t', 'u', 'r')).toBe('NOT_MEMBER');
    expect(await build({ fail: true }).svc.activate('t', 'u', 'r')).toBe('FAILED');
  });
});

describe('EsignBillingReconcileWorker', () => {
  it('activates owners for subscriptions that opened during the sweep; a failing sweep returns 0', async () => {
    const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
    const lifecycle = {
      reconcile: vi.fn(async () => ({
        checked: 2,
        applied: 2,
        failed: 0,
        results: [
          { outcome: 'APPLIED', tenant_id: 't-1', activated_owner_user_id: 'u-1' },
          { outcome: 'APPLIED', tenant_id: 't-2' },
        ],
      })),
      refreshEligibility: vi.fn(async () => ({ checked: 1, lapsed: 0, restored: 0 })),
    } as unknown as SubscriptionLifecycleService;
    expect(await new EsignBillingReconcileWorker(lifecycle, owners).tick()).toBe(2);
    expect(owners.activate).toHaveBeenCalledTimes(1);
    const broken = { reconcile: vi.fn(async () => { throw new Error('db'); }) } as unknown as SubscriptionLifecycleService;
    expect(await new EsignBillingReconcileWorker(broken, owners).tick()).toBe(0);
  });
});
