import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository } from '@aramo/identity';
import { SelfServiceRefusedError, StripeBillingProvider, type SelfServiceBillingService, type SelfServiceRefusal, type SubscriptionLifecycleService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { EsignBillingController, selfServiceHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// CCP-C7 (PBD §5.2 row C7; ADR-0035 D-3; Charter :99) — the sign-service self-service surface:
//   C7-S-OWNER-*  owner-only billing: cancel / upgrade need sign:billing:manage (tenant_owner); a
//                 non-owner (sign_admin / tenant_admin scopes, Sign read) is refused 403 before the
//                 service is reached; the view needs Sign read OR billing authority.
//   C7-S-HTTP-*   every refusal maps to a stable code and lower-case reason; the terms-not-approved
//                 designed disabled state is 503 ESIGN_BILLING_UNAVAILABLE self_service_terms_not_approved.
//   C7-S-BIZ-1    PERSONAL tenants are refused (assertBusiness) before the service is reached.

const auth = (scopes: string[], sub = 'u-owner'): AuthContextType => ({ sub, tenant_id: 't-1', scopes, consumer_type: 'sign' }) as unknown as AuthContextType;
const OWNER = ['sign:billing:manage', 'sign:envelope:read'];
// The scopes a sign_admin / tenant_admin carries in a Sign session: Sign authority, never billing (D-3).
const NON_OWNER = ['sign:envelope:read', 'sign:envelope:send', 'tenant:admin:settings'];

function setup(o: { business?: boolean } = {}) {
  const selfService = {
    view: vi.fn(async () => ({ product_key: 'sign', actions: { cancel: { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' } } })),
    cancel: vi.fn(async () => ({ request_id: 'r-1', action: 'CANCEL_AT_PERIOD_END', status: 'PENDING_PROVIDER', pending_provider: true, replayed: false, command: { id: 'c-1' } })),
    upgrade: vi.fn(async () => {
      throw new SelfServiceRefusedError('FINANCIAL_TREATMENT_UNDEFINED', 'PRICE_CHANGE');
    }),
  } as unknown as SelfServiceBillingService;
  const ctx = {
    tenantOf: vi.fn(async () => ({ id: 't-1', kind: o.business === false ? 'PERSONAL' : 'BUSINESS', status: 'ACTIVE' })),
    assertBusiness: vi.fn(async () => {
      if (o.business === false) throw new AramoError('ESIGN_BILLING_CONFLICT', 'Paid plans are for business organizations', 409, { requestId: 'r', details: { reason: 'personal_tenant' } });
    }),
  } as unknown as SenderContextService;
  const controller = new EsignBillingController(
    {} as SubscriptionLifecycleService,
    new StripeBillingProvider(),
    {} as EsignOwnerActivationService,
    ctx,
    {} as IdentityRepository,
    undefined,
    undefined,
    selfService,
  );
  return { controller, selfService };
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: AramoError) => `${e.code}:${e.statusCode}:${String(e.context.details?.['reason'] ?? '')}`,
  );

describe('CCP-C7 sign-service self-service billing', () => {
  it('C7-S-OWNER-1 cancel and upgrade are owner-only: a non-owner is refused 403 billing_manage_scope_missing and the service is never reached', async () => {
    const { controller, selfService } = setup();
    expect(await outcome(controller.selfServiceCancel(auth(NON_OWNER, 'u-admin'), 'r'))).toBe('INSUFFICIENT_PERMISSIONS:403:billing_manage_scope_missing');
    expect(await outcome(controller.selfServiceUpgrade(auth(NON_OWNER, 'u-admin'), 'r', { plan_key: 'aramo-sign-standard-professional-v1' }))).toBe(
      'INSUFFICIENT_PERMISSIONS:403:billing_manage_scope_missing',
    );
    expect(await outcome(controller.selfServiceCancel(auth([], 'u-none'), 'r'))).toBe('INSUFFICIENT_PERMISSIONS:403:billing_manage_scope_missing');
    expect(selfService.cancel).not.toHaveBeenCalled();
    expect(selfService.upgrade).not.toHaveBeenCalled();
  });

  it('C7-S-OWNER-2 the owner reaches the service with the verified tenant, the Sign product and the acting user; the answer never reports the change as done (C-23)', async () => {
    const { controller, selfService } = setup();
    const out = await controller.selfServiceCancel(auth(OWNER), 'r');
    expect(selfService.cancel).toHaveBeenCalledWith({ tenant_id: 't-1', product_key: 'sign', user_id: 'u-owner' });
    expect(out).toEqual({ request_id: 'r-1', action: 'CANCEL_AT_PERIOD_END', status: 'PENDING_PROVIDER', pending_provider: true, replayed: false });
    expect(await outcome(controller.selfServiceUpgrade(auth(OWNER), 'r', { plan_key: 'aramo-sign-standard-professional-v1' }))).toBe(
      'ESIGN_BILLING_CONFLICT:409:financial_treatment_undefined',
    );
    expect(selfService.upgrade).toHaveBeenCalledWith({ tenant_id: 't-1', product_key: 'sign', plan_key: 'aramo-sign-standard-professional-v1' });
    expect(await outcome(controller.selfServiceUpgrade(auth(OWNER), 'r', {}))).toBe('VALIDATION_ERROR:400:');
  });

  it('C7-S-OWNER-3 the view needs Sign read or billing authority; can_manage_billing is true only for the owner of a BUSINESS tenant', async () => {
    const { controller } = setup();
    expect(await outcome(controller.selfServiceView(auth(['tenant:admin:settings'], 'u-x'), 'r'))).toBe('INSUFFICIENT_PERMISSIONS:403:billing_read_scope_missing');
    expect(await controller.selfServiceView(auth(NON_OWNER, 'u-admin'), 'r')).toMatchObject({ can_manage_billing: false });
    expect(await controller.selfServiceView(auth(OWNER), 'r')).toMatchObject({ can_manage_billing: true, product_key: 'sign' });
    const personal = setup({ business: false });
    expect(await personal.controller.selfServiceView(auth(OWNER), 'r')).toMatchObject({ can_manage_billing: false });
  });

  it('C7-S-BIZ-1 a PERSONAL tenant is refused before the service is reached', async () => {
    const { controller, selfService } = setup({ business: false });
    expect(await outcome(controller.selfServiceCancel(auth(OWNER), 'r'))).toMatch(/^ESIGN_BILLING_CONFLICT:409/);
    expect(selfService.cancel).not.toHaveBeenCalled();
  });

  it('C7-S-HTTP-1 every refusal maps to a stable code and reason; the legal-terms disabled state is 503 self_service_terms_not_approved', () => {
    const expected: Record<SelfServiceRefusal, string> = {
      PRODUCT_NOT_SELF_SERVICE: 'ESIGN_BILLING_UNAVAILABLE:503:product_not_self_service',
      SELF_SERVICE_TERMS_NOT_APPROVED: 'ESIGN_BILLING_UNAVAILABLE:503:self_service_terms_not_approved',
      GOVERNED_SUBSCRIPTION_OPEN: 'ESIGN_BILLING_CONFLICT:409:governed_subscription_open',
      ACTIVATION_PENDING: 'ESIGN_BILLING_CONFLICT:409:activation_pending',
      CONVERSION_IN_PROGRESS: 'ESIGN_BILLING_CONFLICT:409:conversion_in_progress',
      NO_SELF_SERVICE_SUBSCRIPTION: 'ESIGN_BILLING_CONFLICT:409:no_self_service_subscription',
      PROVIDER_CHANGE_PENDING: 'ESIGN_BILLING_CONFLICT:409:provider_change_pending',
      ALREADY_CANCELING: 'ESIGN_BILLING_CONFLICT:409:already_canceling',
      PLAN_NOT_AVAILABLE: 'VALIDATION_ERROR:400:plan_not_available',
      FINANCIAL_TREATMENT_UNDEFINED: 'ESIGN_BILLING_CONFLICT:409:financial_treatment_undefined',
    };
    for (const [reason, want] of Object.entries(expected)) {
      const e = selfServiceHttpError(new SelfServiceRefusedError(reason as SelfServiceRefusal, 'internal detail'), 'r');
      expect(`${e.code}:${e.statusCode}:${String(e.context.details?.['reason'])}`).toBe(want);
      // The tenant copy never carries the internal detail (TD-A6-R-3).
      expect(JSON.stringify({ m: e.message, d: e.context.details })).not.toMatch(/internal detail|reconciliation|flag/i);
    }
    // The held-activation copy is the single safe tenant-facing message (C-8, TD-A6-R-3).
    expect(selfServiceHttpError(new SelfServiceRefusedError('ACTIVATION_PENDING'), 'r').message).toBe('Subscription activation pending — contact support');
  });

  it('C7-S-HTTP-2 an unbound service answers the unavailable state (unit-spec wiring only)', async () => {
    const controller = new EsignBillingController(
      {} as SubscriptionLifecycleService,
      new StripeBillingProvider(),
      {} as EsignOwnerActivationService,
      { assertBusiness: vi.fn(async () => undefined), tenantOf: vi.fn(async () => ({ kind: 'BUSINESS' })) } as unknown as SenderContextService,
      {} as IdentityRepository,
    );
    expect(await outcome(controller.selfServiceCancel(auth(OWNER), 'r'))).toBe('ESIGN_BILLING_UNAVAILABLE:503:BILLING_UNAVAILABLE');
  });
});
