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
import { ESIGN_SCOPE, EsignSenderConsumerGuard, IdentityRepository, PersonalSignupRepository } from '@aramo/identity';
import { DEFAULT_SIGN_BASE_URL, signBaseUrl } from '@aramo/sign';
import {
  BILLING_PROVIDER_PORT,
  BillingWebhookInboxService,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingRefusedError,
  BillingWebhookSignatureError,
  ESIGN_ENVELOPE_ALLOWANCE,
  MeteredUsageService,
  SIGN_PRODUCT_KEY,
  SelfServiceBillingService,
  SelfServiceRefusedError,
  type SelfServiceRefusal,
  SubscriptionLifecycleService,
  TENANT_ACTIVATION_PENDING_MESSAGE,
  approvedLegalDocument,
  checkoutTermsDocument,
  FreePersonalPlanKey,
  type WebhookResult,
} from '@aramo/subscription';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';

import { PersonalSendGate } from '../personal/personal-send.gate.js';
import { logWebhookFailed, logWebhookRejected } from '../webhook-log.js';
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
//   Both POSTs are owner-only (sign:billing:manage); upgrade is BUSINESS-only. Each is refused with
//   the stable reason `self_service_terms_not_approved` while the tenant's terms are not APPROVED
//   (PBD §10).
// Sign Catalog v2 §4.3 (P-4) — a PERSONAL owner (Personal sending switched on, bound tenant) buys
// the Personal plan through the same checkout, portal and cancel; plans of the other tenant kind
// are refused (PLAN_TENANT_KIND_MISMATCH). GET account adds `upgrade` (Free → Standard).
// Dark unless SIGN_PERSONAL_PAID_CHECKOUT_ENABLED=1 (no offer, nothing purchasable, checkout 403
// personal_paid_checkout_not_enabled), and only for a US resident — the declared residence of the
// tenant's PROVISIONED Personal signup (none ⇒ not US): never a non-US Personal user at the provider
// (409 personal_paid_us_only). Personal returns land on /personal/settings/billing.
//   GET  usage            Sign Feature Parity D-2 (A1): the current billing period's metered usage
//                         (per-unit quantities and amounts on the pinned plan version) (Sign read OR
//                         billing authority). Built dark: while SIGN_USAGE_BILLING_ENABLED is not '1'
//                         it answers { enabled: false } and the console shows nothing.
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

/** Sign Catalog v2 §4.3 — SIGN_PERSONAL_PAID_CHECKOUT_ENABLED: only exactly `1` enables (dark default). */
export function personalPaidCheckoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PERSONAL_PAID_CHECKOUT_ENABLED']?.trim() === '1';
}

/** Sign Catalog v2 §4.3 — the only residence a Personal paid plan is sold to. */
export const PERSONAL_PAID_RESIDENCE = 'US';

export type PersonalUpgradeReason = 'not_available_in_country' | 'billing_manage_required' | 'not_purchasable';

/** The console page a checkout / portal returns to: the Personal settings for a PERSONAL tenant. */
function billingReturnPath(tenant_kind: string): string {
  return tenant_kind === 'PERSONAL' ? '/personal/settings/billing' : '/sign/settings/billing';
}

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
    if (e.reason === 'PLAN_TENANT_KIND_MISMATCH') {
      return new AramoError('ESIGN_BILLING_CONFLICT', 'That plan isn’t available for this account', 409, { requestId, details: { reason: 'plan_tenant_kind_mismatch' } });
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
    // Sign Catalog v2 §4.3 — the declared signup residence (unbound ⇒ no residence ⇒ not US).
    @Optional() private readonly signups?: PersonalSignupRepository,
    // Sign Feature Parity D-2 (A1) — metered usage (SubscriptionModule provides it; unbound only in unit specs).
    @Optional() private readonly usage?: MeteredUsageService,
  ) {}

  /** Sign Catalog v2 §4.3 — the tenant's declared Personal signup residence is the US (fail closed). */
  private async personalUsResident(tenant_id: string): Promise<boolean> {
    if (this.signups === undefined) return false;
    try {
      return (await this.signups.declaredResidenceOf(tenant_id)) === PERSONAL_PAID_RESIDENCE;
    } catch (e) {
      this.log.warn(`personal residence lookup failed for ${tenant_id}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

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

  /**
   * Sign Catalog v2 §4.3 — the Free → Standard offer for a PERSONAL tenant: non-null only while the
   * tenant is on the Free plan (or has no plan); `available` when its owner may buy it now.
   */
  private async personalUpgrade(
    tenant_id: string,
    subscription: { plan_key: string; ended_at: Date | null } | null,
    may_buy: boolean,
  ): Promise<{ available: boolean; reason: PersonalUpgradeReason | null; plan_key: string; price_minor: number | null; commitment_months: number | null } | null> {
    // Dark: no offer at all.
    if (!personalPaidCheckoutEnabled()) return null;
    if (subscription !== null && subscription.ended_at === null && subscription.plan_key !== FreePersonalPlanKey) return null;
    const plan = (await this.lifecycle.catalog(SIGN_PRODUCT_KEY, tenant_id, 'PERSONAL')).find(
      (p) => p.tenant_kind === 'PERSONAL' && p.sales_model === 'SELF_SERVICE' && p.key !== FreePersonalPlanKey && p.price !== null,
    );
    if (plan === undefined) return null;
    const reason: PersonalUpgradeReason | null = !(await this.personalUsResident(tenant_id))
      ? 'not_available_in_country'
      : !may_buy
        ? 'billing_manage_required'
        : !plan.purchasable
          ? 'not_purchasable'
          : null;
    return { available: reason === null, reason, plan_key: plan.key, price_minor: plan.price?.amount_minor ?? null, commitment_months: plan.commitment_months };
  }

  @Get('plans')
  @BillingBoundary()
  plans(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      // A1 — the catalog for this tenant (eligibility evaluated), and the terms
      // a checkout must accept (null while no version is approved).
      // Sign Catalog v2 §4.3 — the tenant's kind selects the terms and what is purchasable.
      const kind = await this.ctx.tenantKind(auth.tenant_id, requestId);
      const terms = approvedLegalDocument(checkoutTermsDocument(kind));
      const catalog = await this.lifecycle.catalog(SIGN_PRODUCT_KEY, auth.tenant_id, kind);
      // Sign Catalog v2 §4.3 — a Personal plan is purchasable only while the flag is on, and only
      // for a US resident.
      const personalSellable = kind === 'PERSONAL' && personalPaidCheckoutEnabled() && (await this.personalUsResident(auth.tenant_id));
      return {
        plans: catalog.map((p) => (p.tenant_kind === 'PERSONAL' && p.purchasable && !personalSellable ? { ...p, purchasable: false } : p)),
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
      const personalOpen = kind === 'PERSONAL' && this.ctx.personalAuthoringOpen(tenant);
      if (personalOpen) await this.personal?.ensureFreeSubscription(tenant);
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
        // Sign Catalog v2 §4.3 — a bound PERSONAL tenant (Personal sending on) self-serves too.
        self_service_eligible: kind === 'BUSINESS' || personalOpen,
        can_manage_billing: can_manage && (kind === 'BUSINESS' || personalOpen),
        upgrade: kind === 'PERSONAL' ? await this.personalUpgrade(auth.tenant_id, view.subscription, can_manage && personalOpen) : null,
      };
    });
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  checkout(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { plan_key?: unknown; accept_terms?: unknown }) {
    return this.run(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      // Sign Catalog v2 §4.3 — BUSINESS, or a bound PERSONAL tenant while Personal sending is on
      // (else personal_sending_not_enabled); the plan's tenant kind is checked by the lifecycle.
      const tenant = await this.ctx.assertCanAuthorTenant(auth, requestId);
      if (typeof body?.plan_key !== 'string' || body.plan_key.length === 0 || body.plan_key.length > 100) {
        throw new AramoError('VALIDATION_ERROR', 'plan_key is required', 400, { requestId });
      }
      if (tenant.kind === 'PERSONAL') {
        // Sign Catalog v2 §4.3 — dark unless enabled; then US residents only. Both before any
        // provider call, so a non-US Personal user never reaches the provider.
        if (!personalPaidCheckoutEnabled()) {
          throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Paid plans for personal accounts aren’t available yet', 403, {
            requestId,
            details: { reason: 'personal_paid_checkout_not_enabled' },
          });
        }
        if (!(await this.personalUsResident(auth.tenant_id))) {
          throw new AramoError('ESIGN_BILLING_CONFLICT', 'Paid plans for personal accounts are available to US residents only', 409, {
            requestId,
            details: { reason: 'personal_paid_us_only' },
          });
        }
      }
      const user = await this.identity.findUserById(auth.sub);
      if (user?.email == null) throw new AramoError('VALIDATION_ERROR', 'Your account has no email address', 400, { requestId });
      const base = `${consoleBase()}${billingReturnPath(tenant.kind)}`;
      return this.lifecycle.startCheckout({
        tenant_id: auth.tenant_id,
        product_key: SIGN_PRODUCT_KEY,
        user_id: auth.sub,
        user_email: user.email,
        plan_key: body.plan_key,
        success_url: `${base}?checkout=success`,
        cancel_url: `${base}?checkout=canceled`,
        accept_terms: body.accept_terms === true,
        tenant_kind: tenant.kind,
      });
    });
  }

  @Post('portal')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  portal(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      const kind = await this.ctx.tenantKind(auth.tenant_id, requestId);
      return this.lifecycle.portal(auth.tenant_id, SIGN_PRODUCT_KEY, `${consoleBase()}${billingReturnPath(kind)}`);
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
      const view = await this.selfServiceOf(requestId).view(auth.tenant_id, SIGN_PRODUCT_KEY, tenant.kind);
      return { ...view, can_manage_billing: can_manage && (tenant.kind === 'BUSINESS' || this.ctx.personalAuthoringOpen(tenant)) };
    });
  }

  @Post('self-service/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @BillingBoundary()
  selfServiceCancel(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.runSelfService(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      // Sign Catalog v2 §4.3 — a PERSONAL owner cancels Standard at period end (back to Free).
      const tenant = await this.ctx.assertCanAuthorTenant(auth, requestId);
      const r = await this.selfServiceOf(requestId).cancel({ tenant_id: auth.tenant_id, product_key: SIGN_PRODUCT_KEY, user_id: auth.sub, tenant_kind: tenant.kind });
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

  @Get('usage')
  @BillingBoundary()
  usageView(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      if (!canManageBilling(auth.scopes) && !auth.scopes.includes(ESIGN_READ_SCOPE)) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Viewing usage needs Sign access or billing authority', 403, {
          requestId,
          details: { reason: 'billing_read_scope_missing' },
        });
      }
      // Dark: no period, no units, nothing for the console to show.
      if (this.usage === undefined || !this.usage.enabled()) return { enabled: false, period: null };
      const s = await this.usage.periodSummary(auth.tenant_id, SIGN_PRODUCT_KEY);
      if (s === null) return { enabled: true, period: null };
      return {
        enabled: true,
        period: {
          start: s.period_start.toISOString(),
          end: s.period_end.toISOString(),
          currency: s.currency,
          units: s.units.map((u) => ({
            unit_key: u.unit_key,
            name: u.name,
            quantity_label: u.quantity_label,
            quantity: u.quantity,
            unit_price_minor: u.unit_price_minor,
            amount_minor: u.amount_minor,
          })),
          total_amount_minor: s.total_amount_minor,
        },
      };
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
        logWebhookRejected(this.log, 'stripe_billing', e.reason);
        throw new AramoError('AUTH_REQUIRED', 'Webhook signature verification failed', 401, { requestId, details: { reason: e.reason } });
      }
      throw billingHttpError(e, requestId);
    }
    // Failures propagate (5xx) so the provider redelivers; nothing was recorded.
    const result = await this.run(requestId, async () => {
      try {
        return await (this.inbox !== undefined ? this.inbox.receive(evt, SIGN_PRODUCT_KEY) : this.lifecycle.handleEvent(evt, SIGN_PRODUCT_KEY));
      } catch (e) {
        logWebhookFailed(this.log, 'stripe_billing', e);
        throw e;
      }
    });
    if (result.outcome === 'APPLIED' && result.activated_owner_user_id !== undefined && result.tenant_id !== null) {
      const outcome = await this.owners.activate(result.tenant_id, result.activated_owner_user_id, requestId);
      this.log.log(`subscription opened for tenant ${result.tenant_id}; subscribing-owner activation ${outcome}`);
    }
    return { received: true, outcome: result.outcome };
  }
}
