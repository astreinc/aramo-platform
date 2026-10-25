import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  type RawBodyRequest,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AramoError, AramoExceptionFilter, type ErrorCode, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { ESIGN_SCOPE, EsignSenderConsumerGuard, IdentityRepository } from '@aramo/identity';
import { DEFAULT_SIGN_BASE_URL, signBaseUrl } from '@aramo/sign';
import {
  BILLING_PROVIDER_PORT,
  BillingWebhookInboxService,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingRefusedError,
  BillingWebhookSignatureError,
  ESIGN_ENVELOPE_ALLOWANCE,
  SIGN_PRODUCT_KEY,
  SelfServiceBillingService,
  SelfServiceRefusedError,
  type SelfServiceRefusal,
  SubscriptionLifecycleService,
  TENANT_ACTIVATION_PENDING_MESSAGE,
  approvedLegalDocument,
  type WebhookResult,
} from '@aramo/subscription';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';

import { PersonalSendGate } from '../personal/personal-send.gate.js';
import { ESIGN_READ_SCOPE, SenderContextService } from '../sender/sender-context.service.js';

import { EsignOwnerActivationService } from './esign-owner-activation.service.js';

// Aramo Sign launch — self-service billing on esign.aramo.ai (v1/sign/billing).
//
//   GET  plans            sellable plans (esign consumer + `sign` capability)
//   GET  account          plan, status, period, usage (Sign read OR billing authority)
//   POST checkout         start a provider checkout       (billing authority)
//   POST portal           open the provider billing portal (billing authority)
//   GET  self-service     CCP-C7: the product's self-service state (terms, pending provider
//                         changes, per-action availability) (Sign read OR billing authority)
//   POST self-service/cancel   CCP-C7: the owner's at-period-end cancel, a CCP-C1 durable command
//                              (202, pending-provider until the applied provider state confirms it)
//   POST self-service/upgrade  CCP-C7: gated; refused FINANCIAL_TREATMENT_UNDEFINED (DR-C7-1)
//   Both POSTs are owner-only (sign:billing:manage) and BUSINESS-only, and refused with the stable
//   reason `self_service_terms_not_approved` while the Sign terms are not APPROVED (PBD §10).
//   POST webhook/stripe   provider → Aramo; NO session: authenticity is the
//                         verified Stripe-Signature over the raw body only. CCP-C1: the
//                         verified event is recorded in the webhook inbox before it is
//                         processed (BillingWebhookInboxService; a failure is recorded and
//                         answered 5xx so the provider redelivers).
// tenant_id and the acting user come only from the verified auth context. The
// success / cancel / return URLs are server-built (never taken from the body):
// no open redirect, and the browser never asserts a payment.

// ROLES-1 PR-2 (Directive v1.0 LOCKED §3.4, F-3; ADR-0035 D-3) — billing management
// is `sign:billing:manage` ONLY, which only the organization owner (tenant_owner)
// holds. The former `tenant:admin:settings` fallback is removed: organization
// settings authority alone no longer manages the plan.
export const BILLING_MANAGE_SCOPE = ESIGN_SCOPE.BILLING_MANAGE;

export function canManageBilling(scopes: readonly string[]): boolean {
  return scopes.includes(BILLING_MANAGE_SCOPE);
}

function assertCanManageBilling(auth: AuthContextType, requestId: string): void {
  if (!canManageBilling(auth.scopes)) {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Managing the plan needs the organization owner', 403, {
      requestId,
      details: { reason: 'billing_manage_scope_missing', missing_scopes: [ESIGN_SCOPE.BILLING_MANAGE] },
    });
  }
}

function BillingBoundary(scope?: string): MethodDecorator {
  return applyDecorators(
    UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard),
    RequireCapability('sign'),
    ...(scope !== undefined ? [RequireScopes(scope)] : []),
  );
}

/** Optional "Contact sales" link for Enterprise (SIGN_SALES_CONTACT_URL, http(s) only). */
function salesContactUrl(): string | null {
  const v = process.env['SIGN_SALES_CONTACT_URL']?.trim();
  return v !== undefined && /^(https?:|mailto:)/.test(v) ? v : null;
}

function consoleBase(): string {
  return signBaseUrl() ?? DEFAULT_SIGN_BASE_URL;
}

export function billingHttpError(e: unknown, requestId: string): AramoError {
  if (e instanceof BillingRefusedError) {
    if (e.reason === 'BILLING_UNAVAILABLE') {
      return new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Online billing is not available right now', 503, { requestId, details: { reason: e.reason } });
    }
    if (e.reason === 'PLAN_NOT_SELLABLE') {
      return new AramoError('VALIDATION_ERROR', 'That plan is not available for purchase', 400, { requestId, details: { reason: e.reason } });
    }
    if (e.reason === 'TERMS_NOT_ACCEPTED') {
      return new AramoError('VALIDATION_ERROR', 'Accept the terms to continue', 400, { requestId, details: { reason: e.reason } });
    }
    if (e.reason === 'PORTAL_NOT_CONFIGURED') {
      return new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Managing billing online isn’t available yet. Contact Aramo to change your subscription.', 503, {
        requestId,
        details: { reason: e.reason },
      });
    }
    if (e.reason === 'TERMS_NOT_APPROVED') {
      return new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Online billing is not available right now', 503, { requestId, details: { reason: e.reason } });
    }
    if (e.reason === 'ORGANIZATION_PROFILE_REQUIRED') {
      // Sign Signup A1 §2.6 — checkout needs an eligible (US) organization profile.
      const reason = e.message === 'organization_country_not_supported' ? 'organization_country_not_supported' : 'organization_profile_incomplete';
      return new AramoError('ESIGN_BILLING_CONFLICT', 'Complete your organization’s legal name and US address in Settings before subscribing', 409, {
        requestId,
        details: { reason },
      });
    }
    if (e.reason === 'DOMAIN_VERIFICATION_REQUIRED') {
      // Domain-Enforcement P3 §4 — a new subscription needs an AUTHORITATIVE domain claim.
      return new AramoError(
        'ESIGN_BILLING_CONFLICT',
        'Verify your organization’s email domain before subscribing. You can assign this to your IT administrator in Settings.',
        409,
        { requestId, details: { reason: 'domain_verification_required' } },
      );
    }
    if (e.reason === 'GOVERNED_SUBSCRIPTION_OPEN') {
      // CCP-A6 (Conversion Rule C-1, C-4) — the organization's subscription is managed by Aramo;
      // changing it to self-service is a governed conversion, not a checkout.
      return new AramoError('ESIGN_BILLING_CONFLICT', 'Your organization’s subscription is managed by Aramo. Contact Aramo to change it.', 409, {
        requestId,
        details: { reason: 'governed_subscription_open' },
      });
    }
    if (e.reason === 'PLAN_NOT_ELIGIBLE') {
      return new AramoError('ESIGN_BILLING_CONFLICT', 'This plan requires an Aramo ATS subscription', 409, { requestId, details: { reason: e.reason } });
    }
    return new AramoError('ESIGN_BILLING_CONFLICT', e.reason === 'ALREADY_SUBSCRIBED' ? 'Your organization already has a subscription; manage it in billing' : 'Your organization has no billing account yet', 409, {
      requestId,
      details: { reason: e.reason },
    });
  }
  if (e instanceof BillingProviderUnavailableError) {
    return new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Online billing is not available right now', 503, { requestId, details: { reason: 'PROVIDER_UNAVAILABLE' } });
  }
  return e instanceof AramoError ? e : new AramoError('INTERNAL_ERROR', 'Billing request failed', 500, { requestId });
}

// CCP-C7 — the tenant-facing copy of each self-service refusal: a stable reason, never an internal
// conflict, flag or contract detail (TD-A6-R-3). The terms-not-approved state is the designed
// disabled state (PBD §10).
const SELF_SERVICE_HTTP: Readonly<Record<SelfServiceRefusal, { code: ErrorCode; status: number; message: string }>> = {
  PRODUCT_NOT_SELF_SERVICE: { code: 'ESIGN_BILLING_UNAVAILABLE', status: 503, message: 'Changing your plan online isn’t available. Contact Aramo to change your subscription.' },
  SELF_SERVICE_TERMS_NOT_APPROVED: { code: 'ESIGN_BILLING_UNAVAILABLE', status: 503, message: 'Changing your plan online isn’t available yet. Contact Aramo to change your subscription.' },
  GOVERNED_SUBSCRIPTION_OPEN: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'Your organization’s subscription is managed by Aramo. Contact Aramo to change it.' },
  ACTIVATION_PENDING: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: TENANT_ACTIVATION_PENDING_MESSAGE },
  CONVERSION_IN_PROGRESS: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'Aramo is changing your subscription. Contact Aramo for details.' },
  NO_SELF_SERVICE_SUBSCRIPTION: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'Your organization has no online subscription to change.' },
  PROVIDER_CHANGE_PENDING: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'A change to your subscription is still being confirmed. Try again later.' },
  ALREADY_CANCELING: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'Your subscription is already set to end at the end of the period.' },
  PLAN_NOT_AVAILABLE: { code: 'VALIDATION_ERROR', status: 400, message: 'That plan is not available for a change.' },
  FINANCIAL_TREATMENT_UNDEFINED: { code: 'ESIGN_BILLING_CONFLICT', status: 409, message: 'This change can’t be made online. Contact Aramo to change your subscription.' },
};

export function selfServiceHttpError(e: unknown, requestId: string): AramoError {
  if (e instanceof SelfServiceRefusedError) {
    const m = SELF_SERVICE_HTTP[e.reason];
    return new AramoError(m.code, m.message, m.status, { requestId, details: { reason: e.reason.toLowerCase() } });
  }
  return billingHttpError(e, requestId);
}

@Controller('v1/sign/billing')
@UseFilters(AramoExceptionFilter)
export class EsignBillingController {
  private readonly log = new Logger(EsignBillingController.name);

  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
    private readonly owners: EsignOwnerActivationService,
    private readonly ctx: SenderContextService,
    private readonly identity: IdentityRepository,
    // Personal Free v1.1 §4 — opens the FREE subscription lazily on account read.
    @Optional() private readonly personal?: PersonalSendGate,
    // CCP-C1 — the webhook inbox (SubscriptionModule provides it; unbound only in unit specs).
    @Optional() private readonly inbox?: BillingWebhookInboxService,
    // CCP-C7 — tenant self-service (SubscriptionModule provides it; unbound only in unit specs).
    @Optional() private readonly selfService?: SelfServiceBillingService,
  ) {}

  private selfServiceOf(requestId: string): SelfServiceBillingService {
    if (this.selfService === undefined) throw new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Online billing is not available right now', 503, { requestId, details: { reason: 'BILLING_UNAVAILABLE' } });
    return this.selfService;
  }

  private async runSelfService<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw selfServiceHttpError(e, requestId);
    }
  }

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw billingHttpError(e, requestId);
    }
  }

  @Get('plans')
  @BillingBoundary()
  plans(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      // A1 — the catalog for this tenant (eligibility evaluated), and the terms
      // a checkout must accept (null while no version is approved).
      const terms = approvedLegalDocument('sign.terms_of_service');
      return {
        plans: await this.lifecycle.catalog(SIGN_PRODUCT_KEY, auth.tenant_id),
        terms: terms === null ? null : { version: terms.version, url: terms.url },
        sales_contact_url: salesContactUrl(),
      };
    });
  }

  @Get('account')
  @BillingBoundary()
  account(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      const scopes = new Set(auth.scopes);
      const can_manage = canManageBilling(auth.scopes);
      if (!can_manage && !scopes.has(ESIGN_READ_SCOPE)) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Viewing the plan needs Sign access or billing authority', 403, {
          requestId,
          details: { reason: 'billing_read_scope_missing' },
        });
      }
      const tenant = await this.ctx.tenantOf(auth.tenant_id, requestId);
      const kind = tenant.kind;
      // Personal Free v1.1 §4 — a bound PERSONAL tenant's FREE subscription (mode not off).
      if (kind === 'PERSONAL' && this.ctx.personalAuthoringOpen(tenant)) await this.personal?.ensureFreeSubscription(tenant);
      const view = await this.lifecycle.account(auth.tenant_id, SIGN_PRODUCT_KEY, ESIGN_ENVELOPE_ALLOWANCE);
      // Heal path: the subscribing owner whose role grant did not land at the
      // webhook (e.g. a transient identity failure) receives it on their next read.
      const owner = await this.lifecycle.sendingOwner(auth.tenant_id, SIGN_PRODUCT_KEY);
      if (owner === auth.sub && !scopes.has(ESIGN_READ_SCOPE)) await this.owners.activate(auth.tenant_id, auth.sub, requestId);
      return {
        ...view,
        // CCP-A6-R (Conversion Rule C-8) — a held self-service activation, as a safe billing-support
        // state only (no flag, reason or contract detail; never an activation).
        pending_activation: await this.lifecycle.tenantActivationState(auth.tenant_id, SIGN_PRODUCT_KEY),
        tenant_kind: kind,
        // PERSONAL commercial sending stays deferred (fixed boundary).
        self_service_eligible: kind === 'BUSINESS',
        can_manage_billing: can_manage && kind === 'BUSINESS',
      };
    });
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  checkout(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { plan_key?: unknown; accept_terms?: unknown }) {
    return this.run(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      // Paid checkout is Business-only whatever the Personal mode (no Stripe for Free Personal).
      await this.ctx.assertBusiness(auth, requestId);
      if (typeof body?.plan_key !== 'string' || body.plan_key.length === 0 || body.plan_key.length > 100) {
        throw new AramoError('VALIDATION_ERROR', 'plan_key is required', 400, { requestId });
      }
      const user = await this.identity.findUserById(auth.sub);
      if (user?.email == null) throw new AramoError('VALIDATION_ERROR', 'Your account has no email address', 400, { requestId });
      const base = consoleBase();
      return this.lifecycle.startCheckout({
        tenant_id: auth.tenant_id,
        product_key: SIGN_PRODUCT_KEY,
        user_id: auth.sub,
        user_email: user.email,
        plan_key: body.plan_key,
        success_url: `${base}/sign/settings/billing?checkout=success`,
        cancel_url: `${base}/sign/settings/billing?checkout=canceled`,
        accept_terms: body.accept_terms === true,
      });
    });
  }

  @Post('portal')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  portal(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      return this.lifecycle.portal(auth.tenant_id, SIGN_PRODUCT_KEY, `${consoleBase()}/sign/settings/billing`);
    });
  }

  @Get('self-service')
  @BillingBoundary()
  selfServiceView(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.runSelfService(requestId, async () => {
      const can_manage = canManageBilling(auth.scopes);
      if (!can_manage && !auth.scopes.includes(ESIGN_READ_SCOPE)) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Viewing the plan needs Sign access or billing authority', 403, {
          requestId,
          details: { reason: 'billing_read_scope_missing' },
        });
      }
      const tenant = await this.ctx.tenantOf(auth.tenant_id, requestId);
      const view = await this.selfServiceOf(requestId).view(auth.tenant_id, SIGN_PRODUCT_KEY);
      return { ...view, can_manage_billing: can_manage && tenant.kind === 'BUSINESS' };
    });
  }

  @Post('self-service/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @BillingBoundary()
  selfServiceCancel(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.runSelfService(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      await this.ctx.assertBusiness(auth, requestId);
      const r = await this.selfServiceOf(requestId).cancel({ tenant_id: auth.tenant_id, product_key: SIGN_PRODUCT_KEY, user_id: auth.sub });
      // C-23: never reported as done on local commit; only the request and its pending state.
      return { request_id: r.request_id, action: r.action, status: r.status, pending_provider: r.pending_provider, replayed: r.replayed };
    });
  }

  @Post('self-service/upgrade')
  @HttpCode(HttpStatus.ACCEPTED)
  @BillingBoundary()
  selfServiceUpgrade(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { plan_key?: unknown }) {
    return this.runSelfService(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      await this.ctx.assertBusiness(auth, requestId);
      if (typeof body?.plan_key !== 'string' || body.plan_key.length === 0 || body.plan_key.length > 100) {
        throw new AramoError('VALIDATION_ERROR', 'plan_key is required', 400, { requestId });
      }
      return this.selfServiceOf(requestId).upgrade({ tenant_id: auth.tenant_id, product_key: SIGN_PRODUCT_KEY, plan_key: body.plan_key });
    });
  }

  @Post('webhook/stripe')
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ received: true; outcome: WebhookResult['outcome'] }> {
    const raw = req.rawBody;
    let evt;
    try {
      if (raw === undefined) throw new BillingWebhookSignatureError('MISSING');
      evt = this.billing.verifyWebhook(raw, signature, Math.floor(Date.now() / 1000));
    } catch (e) {
      if (e instanceof BillingWebhookSignatureError) {
        this.log.warn(`billing webhook rejected: ${e.reason}`);
        throw new AramoError('AUTH_REQUIRED', 'Webhook signature verification failed', 401, { requestId, details: { reason: e.reason } });
      }
      throw billingHttpError(e, requestId);
    }
    // Failures propagate (5xx) so the provider redelivers; nothing was recorded.
    const result = await this.run(requestId, () =>
      this.inbox !== undefined ? this.inbox.receive(evt, SIGN_PRODUCT_KEY) : this.lifecycle.handleEvent(evt, SIGN_PRODUCT_KEY),
    );
    if (result.outcome === 'APPLIED' && result.activated_owner_user_id !== undefined && result.tenant_id !== null) {
      const outcome = await this.owners.activate(result.tenant_id, result.activated_owner_user_id, requestId);
      this.log.log(`subscription opened for tenant ${result.tenant_id}; subscribing-owner activation ${outcome}`);
    }
    return { received: true, outcome: result.outcome };
  }
}
