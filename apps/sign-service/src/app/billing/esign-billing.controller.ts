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
  Query,
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
  BILLING_GATEWAY_REGISTRY,
  BILLING_PROVIDER_PORT,
  type BillingGatewayRegistry,
  BillingWebhookInboxService,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingRefusedError,
  BillingWebhookSignatureError,
  ESIGN_ENVELOPE_ALLOWANCE,
  MeteredUsageService,
  SIGN_PRODUCT_KEY,
  SeatBillingService,
  SeatChangeRefusedError,
  SelfServiceBillingService,
  SelfServiceRefusedError,
  validSeatCount,
  type SelfServiceRefusal,
  SubscriptionLifecycleService,
  TENANT_ACTIVATION_PENDING_MESSAGE,
  approvedLegalDocument,
  checkoutTermsDocument,
  FreePersonalPlanKey,
  type WebhookResult,
  StoreBillingRefusedError,
  StoreBillingService,
  StoreVerificationError,
  type StoreCaller,
  type StorePlatform,
} from '@aramo/subscription';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';

import { PersonalSendGate } from '../personal/personal-send.gate.js';
import { type SignWebhookSource, logWebhookFailed, logWebhookRejected } from '../webhook-log.js';
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
//   M-A12 W1-G (Sign Mobile in-app purchase; dark unless SIGN_STORE_BILLING_ENABLED=1):
//   POST store/intent     the tenant-bound purchase token (appAccountToken / obfuscatedAccountId)
//   POST store/verify     one store purchase verified server-side, applied from the store's state
//   POST store/restore    the device's store purchases, each verified and applied
//   POST webhook/app-store    App Store Server Notifications v2 (signed payload verified; NO session)
//   POST webhook/google-play  Google RTDN Pub/Sub push (OIDC bearer verified; NO session)
//   GET plans is filtered to the caller's tenant kind (A5) and carries each plan's store products and
//   the regional price for the caller's billing country (A1-3); GET account carries where the plan is
//   managed and whether the caller may buy in the app (A1-2).
//   POST seats            Sign Business per-seat pricing (directive v1.0 §3.3.3): the owner or an admin
//                         changes the purchased seats of a Stripe-billed per-seat subscription; an increase
//                         is prorated now, a decrease applies at period end (no refund), never below the
//                         seats in use (409 seats_below_usage). GET account carries price_unit, seats
//                         { purchased, used, pending_purchased } and can_manage_seats; GET plans each
//                         plan's price_unit; checkout takes `seats` for a per-seat plan.
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
    if (e.reason === 'BILLING_MANAGED_ELSEWHERE') {
      // M-A12 W1-G item 5 — the plan is billed through the App Store or Google Play.
      return new AramoError('ESIGN_BILLING_CONFLICT', 'Your plan is managed in the app store. Manage it there.', 409, { requestId, details: { reason: 'billing_managed_elsewhere' } });
    }
    if (e.reason === 'SEATS_NOT_APPLICABLE') {
      // Sign Business per-seat pricing — `seats` for a plan priced per organization.
      return new AramoError('VALIDATION_ERROR', 'This plan is priced per organization; it has no seat count', 422, { requestId, details: { reason: 'seats_not_applicable' } });
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
  if (e instanceof StoreBillingRefusedError) return storeHttpError(e, requestId);
  if (e instanceof SeatChangeRefusedError) return seatHttpError(e, requestId);
  return e instanceof AramoError ? e : new AramoError('INTERNAL_ERROR', 'Billing request failed', 500, { requestId });
}

// Sign Business per-seat pricing — the tenant-facing copy of each seat-change refusal (409, stable reason).
const SEAT_MESSAGES: Readonly<Record<SeatChangeRefusedError['reason'], string>> = {
  seats_not_applicable: 'Your plan isn’t priced per seat, or its seats can’t be changed online.',
  seats_below_usage: 'You can’t have fewer seats than the people who use Aramo Sign. Remove someone’s access first.',
  seats_unchanged: 'You already have that many seats.',
};

export function seatHttpError(e: SeatChangeRefusedError, requestId: string): AramoError {
  return new AramoError('ESIGN_BILLING_CONFLICT', SEAT_MESSAGES[e.reason], 409, { requestId, details: { reason: e.reason, ...e.details } });
}

/** Sign Business per-seat pricing (O-3) — the organization owner or an admin manages the seats. */
export const SEAT_MANAGER_ROLE_KEYS: readonly string[] = ['tenant_owner', 'tenant_admin'];

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

// M-A12 W1-G — the tenant-facing copy of each store refusal (a stable reason; never a JWS, token or
// store payload detail).
const STORE_MESSAGES: Readonly<Record<StoreBillingRefusedError['reason'], string>> = {
  store_billing_disabled: 'In-app purchase isn’t available right now.',
  not_billing_manager: 'Ask your admin to change the plan.',
  store_purchase_seats_unsupported: 'Manage your plan at sign.aramo.ai.',
  billing_managed_elsewhere: 'Your plan is managed elsewhere. Manage it where you bought it.',
  store_purchase_bound_elsewhere: 'This purchase belongs to another Aramo Sign account.',
  store_purchase_invalid: 'We couldn’t verify this purchase.',
  store_product_not_available: 'That plan isn’t available in the app.',
  domain_verification_required: 'Verify your organization’s email domain before subscribing.',
};

export function storeHttpError(e: StoreBillingRefusedError, requestId: string): AramoError {
  const code: ErrorCode =
    e.status === 503 ? 'ESIGN_BILLING_UNAVAILABLE' : e.status === 403 ? 'INSUFFICIENT_PERMISSIONS' : e.status === 422 ? 'VALIDATION_ERROR' : 'ESIGN_BILLING_CONFLICT';
  return new AramoError(code, STORE_MESSAGES[e.reason], e.status, { requestId, details: { reason: e.reason } });
}

const STORE_PLATFORMS: readonly StorePlatform[] = ['ios', 'android'];
const STORE_PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STORE_TOKEN = 16_384;

function badStoreBody(requestId: string, message: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

function onlyKeys(body: unknown, keys: readonly string[], requestId: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badStoreBody(requestId, 'A JSON object is required');
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw badStoreBody(requestId, `Unknown field(s): ${extra.slice(0, 5).join(', ')}`);
  return o;
}

function storePlatform(v: unknown, requestId: string): StorePlatform {
  if (typeof v !== 'string' || !(STORE_PLATFORMS as readonly string[]).includes(v)) throw badStoreBody(requestId, 'platform must be ios or android');
  return v as StorePlatform;
}

function storeToken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STORE_TOKEN;
}

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
    // M-A12 W1-G — in-app store billing (SubscriptionModule provides it; unbound only in unit specs).
    @Optional() private readonly store?: StoreBillingService,
    // Sign Business per-seat pricing — seats (SubscriptionModule provides it; unbound only in unit specs).
    @Optional() private readonly seats?: SeatBillingService,
    // India Billing (directive v1.0 §4.3, §4.7) — the web gateways by key (SubscriptionModule provides
    // it; unbound only in unit specs, where the Razorpay webhook is then 404).
    @Optional() @Inject(BILLING_GATEWAY_REGISTRY) private readonly gateways?: BillingGatewayRegistry,
  ) {}

  /** O-3 — whether the caller is the organization owner or an admin (their live role keys in this tenant). */
  private async managesSeats(auth: AuthContextType): Promise<boolean> {
    const membership = await this.identity.findMembership({ user_id: auth.sub, tenant_id: auth.tenant_id });
    if (membership === null || !membership.is_active) return false;
    const keys = await this.identity.findRoleKeysForMembership(membership.id);
    return keys.some((k) => SEAT_MANAGER_ROLE_KEYS.includes(k));
  }

  /** Sign Business per-seat pricing — the account's seat view (null unless the pinned version is per seat). */
  private async seatView(auth: AuthContextType, kind: string): Promise<{ seats: { purchased: number; used: number; pending_purchased: number | null } | null; can_manage_seats: boolean }> {
    const state = this.seats === undefined || kind !== 'BUSINESS' ? null : await this.seats.seatState(auth.tenant_id, SIGN_PRODUCT_KEY);
    if (state === null || state.price_unit !== 'SEAT' || state.purchased === null) return { seats: null, can_manage_seats: false };
    return {
      seats: { purchased: state.purchased, used: await this.identity.countSignSeats(auth.tenant_id), pending_purchased: state.pending_purchased },
      can_manage_seats: state.changeable && (await this.managesSeats(auth)),
    };
  }

  /** M-A12 — the declared residence (ISO alpha-2) of a PERSONAL tenant's signup, or null. */
  private async residenceOf(tenant_id: string): Promise<string | null> {
    if (this.signups === undefined) return null;
    try {
      return (await this.signups.declaredResidenceOf(tenant_id)) ?? null;
    } catch {
      return null;
    }
  }

  private storeOf(requestId: string): StoreBillingService {
    if (this.store === undefined) throw storeHttpError(new StoreBillingRefusedError('store_billing_disabled'), requestId);
    return this.store;
  }

  /** M-A12 — the store caller (tenant kind, billing authority, Personal authoring) from the auth context. */
  private async storeCaller(auth: AuthContextType, requestId: string): Promise<StoreCaller & { tenant: Awaited<ReturnType<SenderContextService['tenantOf']>> }> {
    const tenant = await this.ctx.tenantOf(auth.tenant_id, requestId);
    return {
      tenant,
      tenant_id: auth.tenant_id,
      user_id: auth.sub,
      tenant_kind: tenant.kind,
      can_manage: canManageBilling(auth.scopes),
      personal_open: tenant.kind === 'PERSONAL' && this.ctx.personalAuthoringOpen(tenant),
    };
  }

  /** The account view (GET account, and the answer of store verify / restore). */
  private async accountView(auth: AuthContextType, requestId: string) {
    const scopes = new Set(auth.scopes);
    const can_manage = canManageBilling(auth.scopes);
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
    // M-A12 W1-G / A1-2 — where the plan is managed and whether this caller may buy in the app.
    const store =
      this.store !== undefined
        ? await this.store.accountView(
            { tenant_id: auth.tenant_id, user_id: auth.sub, tenant_kind: kind, can_manage, personal_open: personalOpen },
            SIGN_PRODUCT_KEY,
            `${consoleBase()}${billingReturnPath(kind)}`,
          )
        : { managed_by: null, store_purchase_eligible: false, store_purchase_block_reason: 'store_billing_disabled' as const, manage_url: null };
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
      ...store,
      // Sign Business per-seat pricing (directive v1.0 §3.3.4).
      ...(await this.seatView(auth, kind)),
    };
  }

  /** After a store state is applied: the subscribing-owner role, and (Personal) the Free fallback. */
  private async afterStoreApply(result: { outcome: string; tenant_id: string | null; activated_owner_user_id?: string }, requestId: string): Promise<void> {
    if (result.tenant_id === null) return;
    if (result.outcome === 'APPLIED' && result.activated_owner_user_id !== undefined) {
      const outcome = await this.owners.activate(result.tenant_id, result.activated_owner_user_id, requestId);
      this.log.log(`store subscription applied for tenant ${result.tenant_id}; subscribing-owner activation ${outcome}`);
    }
    // M-A12 W1-G item 4 — an expired / refunded Personal store plan falls back to the Free plan (the
    // FREE subscription opens only when no other subscription is open).
    try {
      const tenant = await this.ctx.tenantOf(result.tenant_id, requestId);
      if (tenant.kind === 'PERSONAL' && this.ctx.personalAuthoringOpen(tenant)) await this.personal?.ensureFreeSubscription(tenant);
    } catch (e) {
      this.log.warn(`free fallback check failed for ${result.tenant_id}: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

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
  plans(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query('country') countryParam?: string) {
    return this.run(requestId, async () => {
      // M-A12 A1-3 — the caller's billing country: the store storefront country the app sends
      // (ISO alpha-2), else a PERSONAL tenant's declared residence; else none.
      const queried = typeof countryParam === 'string' && /^[A-Za-z]{2}$/.test(countryParam.trim()) ? countryParam.trim().toUpperCase() : null;
      // A1 — the catalog for this tenant (eligibility evaluated), and the terms
      // a checkout must accept (null while no version is approved).
      // Sign Catalog v2 §4.3 — the tenant's kind selects the terms and what is purchasable.
      const kind = await this.ctx.tenantKind(auth.tenant_id, requestId);
      const terms = approvedLegalDocument(checkoutTermsDocument(kind));
      const catalog = await this.lifecycle.catalog(SIGN_PRODUCT_KEY, auth.tenant_id, kind);
      // Sign Catalog v2 §4.3 — a Personal plan is purchasable only while the flag is on, and only
      // for a US resident.
      const personalSellable = kind === 'PERSONAL' && personalPaidCheckoutEnabled() && (await this.personalUsResident(auth.tenant_id));
      const country = queried ?? (kind === 'PERSONAL' ? await this.residenceOf(auth.tenant_id) : null);
      const offers = this.store !== undefined ? await this.store.planOffers(SIGN_PRODUCT_KEY, country) : new Map();
      return {
        // M-A12 R-2 — `catalog` is already filtered to the caller's tenant kind (A5).
        plans: catalog.map((p) => {
          const plan = p.tenant_kind === 'PERSONAL' && p.purchasable && !personalSellable ? { ...p, purchasable: false } : p;
          const offer = offers.get(p.key);
          const regional = offer?.regional_prices ?? [];
          return {
            ...plan,
            store_products: offer?.store_products ?? [],
            // The monthly regional price when one exists, else the annual one; every interval in regional_prices.
            regional_price: regional.find((r: { interval: string }) => r.interval === 'MONTH') ?? regional[0] ?? null,
            regional_prices: regional,
          };
        }),
        terms: terms === null ? null : { version: terms.version, url: terms.url },
        sales_contact_url: salesContactUrl(),
      };
    });
  }

  @Get('account')
  @BillingBoundary()
  account(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, async () => {
      if (!canManageBilling(auth.scopes) && !auth.scopes.includes(ESIGN_READ_SCOPE)) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Viewing the plan needs Sign access or billing authority', 403, {
          requestId,
          details: { reason: 'billing_read_scope_missing' },
        });
      }
      return this.accountView(auth, requestId);
    });
  }

  // ---- M-A12 W1-G: in-app store billing ------------------------------------------------------

  @Post('store/intent')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  storeIntent(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, async () => {
      const b = onlyKeys(body, ['platform', 'product_id'], requestId);
      const platform = storePlatform(b['platform'], requestId);
      if (typeof b['product_id'] !== 'string' || !STORE_PRODUCT_ID.test(b['product_id'])) throw badStoreBody(requestId, 'product_id is required');
      const caller = await this.storeCaller(auth, requestId);
      return this.storeOf(requestId).createIntent(caller, SIGN_PRODUCT_KEY, { platform, product_id: b['product_id'] });
    });
  }

  @Post('store/verify')
  @HttpCode(HttpStatus.OK)
  @BillingBoundary()
  storeVerify(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, async () => {
      const b = onlyKeys(body, ['platform', 'product_id', 'intent_id', 'signed_transaction', 'purchase_token'], requestId);
      const platform = storePlatform(b['platform'], requestId);
      if (typeof b['product_id'] !== 'string' || !STORE_PRODUCT_ID.test(b['product_id'])) throw badStoreBody(requestId, 'product_id is required');
      if (typeof b['intent_id'] !== 'string' || !UUID_RE.test(b['intent_id'])) throw badStoreBody(requestId, 'intent_id must be a uuid');
      const signed_transaction = b['signed_transaction'];
      const purchase_token = b['purchase_token'];
      if (platform === 'ios' ? !storeToken(signed_transaction) : !storeToken(purchase_token)) {
        throw badStoreBody(requestId, platform === 'ios' ? 'signed_transaction is required' : 'purchase_token is required');
      }
      const caller = await this.storeCaller(auth, requestId);
      const result = await this.storeOf(requestId).verify(caller, SIGN_PRODUCT_KEY, {
        platform,
        product_id: b['product_id'],
        intent_id: b['intent_id'].toLowerCase(),
        ...(platform === 'ios' ? { signed_transaction: signed_transaction as string } : { purchase_token: purchase_token as string }),
      });
      await this.afterStoreApply(result, requestId);
      return this.accountView(auth, requestId);
    });
  }

  @Post('store/restore')
  @HttpCode(HttpStatus.OK)
  @BillingBoundary()
  storeRestore(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, async () => {
      const b = onlyKeys(body, ['platform', 'signed_transactions', 'purchase_tokens'], requestId);
      const platform = storePlatform(b['platform'], requestId);
      const list = platform === 'ios' ? b['signed_transactions'] : b['purchase_tokens'];
      if (!Array.isArray(list) || list.length > 10 || !list.every(storeToken)) {
        throw badStoreBody(requestId, `${platform === 'ios' ? 'signed_transactions' : 'purchase_tokens'} must be an array of at most 10 entries`);
      }
      const caller = await this.storeCaller(auth, requestId);
      const results = await this.storeOf(requestId).restore(caller, SIGN_PRODUCT_KEY, platform === 'ios' ? { platform, signed_transactions: list } : { platform, purchase_tokens: list });
      for (const r of results) await this.afterStoreApply(r, requestId);
      return this.accountView(auth, requestId);
    });
  }

  @Post('webhook/app-store')
  @HttpCode(HttpStatus.OK)
  async appStoreWebhook(@Body() body: unknown, @RequestId() requestId: string): Promise<{ received: true; outcome: WebhookResult['outcome'] }> {
    return this.storeWebhook('app_store_billing', requestId, (svc) =>
      svc.receiveAppleNotification(typeof body === 'object' && body !== null ? (body as { signedPayload?: unknown }).signedPayload : undefined, SIGN_PRODUCT_KEY),
    );
  }

  @Post('webhook/google-play')
  @HttpCode(HttpStatus.OK)
  async googlePlayWebhook(@Body() body: unknown, @Headers('authorization') authorization: string | undefined, @RequestId() requestId: string): Promise<{ received: true; outcome: WebhookResult['outcome'] }> {
    return this.storeWebhook('google_play_billing', requestId, (svc) => svc.receiveGooglePush(authorization, body, SIGN_PRODUCT_KEY));
  }

  /**
   * The store webhooks: NO session; authenticity is the verified signature / OIDC bearer. Disabled →
   * 404 (no such endpoint while dark). Not authentic → 401. A processing failure → 5xx (the store
   * redelivers). The state applied is re-fetched from the store (the inbox → lifecycle).
   */
  private async storeWebhook(
    channel: SignWebhookSource,
    requestId: string,
    fn: (svc: StoreBillingService) => Promise<WebhookResult>,
  ): Promise<{ received: true; outcome: WebhookResult['outcome'] }> {
    if (this.store === undefined || !this.store.enabled()) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
    let result: WebhookResult;
    try {
      result = await fn(this.store);
    } catch (e) {
      if (e instanceof StoreBillingRefusedError && e.reason === 'store_billing_disabled') throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
      if (e instanceof StoreVerificationError) {
        logWebhookRejected(this.log, channel, e.reason);
        throw new AramoError('AUTH_REQUIRED', 'Webhook verification failed', 401, { requestId, details: { reason: e.reason } });
      }
      logWebhookFailed(this.log, channel, e);
      throw billingHttpError(e, requestId);
    }
    if (result.outcome !== 'DUPLICATE') await this.afterStoreApply(result, requestId);
    return { received: true, outcome: result.outcome };
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary()
  checkout(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { plan_key?: unknown; accept_terms?: unknown; seats?: unknown }) {
    return this.run(requestId, async () => {
      assertCanManageBilling(auth, requestId);
      // Sign Catalog v2 §4.3 — BUSINESS, or a bound PERSONAL tenant while Personal sending is on
      // (else personal_sending_not_enabled); the plan's tenant kind is checked by the lifecycle.
      const tenant = await this.ctx.assertCanAuthorTenant(auth, requestId);
      if (typeof body?.plan_key !== 'string' || body.plan_key.length === 0 || body.plan_key.length > 100) {
        throw new AramoError('VALIDATION_ERROR', 'plan_key is required', 400, { requestId });
      }
      // Sign Business per-seat pricing (§3.3.1) — seats is an integer 1..1000 (a per-seat plan only).
      if (body.seats !== undefined && !validSeatCount(body.seats)) {
        throw new AramoError('VALIDATION_ERROR', 'seats must be an integer from 1 to 1000', 400, { requestId, details: { reason: 'seats_invalid' } });
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
        ...(body.seats !== undefined ? { seats: body.seats as number } : {}),
      });
    });
  }

  /**
   * Sign Business per-seat pricing (directive v1.0 §3.3.3, O-2, O-3) — the owner or an admin changes the
   * purchased seats. Increase: prorated now. Decrease: at period end, never below the seats in use.
   */
  @Post('seats')
  @HttpCode(HttpStatus.OK)
  @BillingBoundary()
  changeSeats(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { seats?: unknown }) {
    return this.run(requestId, async () => {
      await this.ctx.assertBusiness(auth, requestId);
      if (!(await this.managesSeats(auth))) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Only the organization owner or an admin can change seats', 403, {
          requestId,
          details: { reason: 'seat_manage_role_required' },
        });
      }
      if (!validSeatCount(body?.seats)) {
        throw new AramoError('VALIDATION_ERROR', 'seats must be an integer from 1 to 1000', 400, { requestId, details: { reason: 'seats_invalid' } });
      }
      if (this.seats === undefined) throw seatHttpError(new SeatChangeRefusedError('seats_not_applicable'), requestId);
      const used = await this.identity.countSignSeats(auth.tenant_id);
      return this.seats.changeSeats({ tenant_id: auth.tenant_id, product_key: SIGN_PRODUCT_KEY, seats: body.seats, used });
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

  /**
   * India Billing (directive v1.0 §4.7, G-4) — the Razorpay webhook: NO session; authenticity is the
   * X-Razorpay-Signature header (hex HMAC-SHA256 over the raw body). Dark (404, no such endpoint) unless
   * SIGN_RAZORPAY_BILLING_ENABLED is exactly '1' and the registry is bound. Not authentic → 401. Each
   * event is recorded in the billing webhook inbox and processed at most once; the subscription state
   * is re-fetched from Razorpay before it is applied. A processing failure → 5xx (Razorpay redelivers).
   */
  @Post('webhook/razorpay')
  @HttpCode(HttpStatus.OK)
  async razorpayWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ received: true; outcome: WebhookResult['outcome'] }> {
    if (process.env['SIGN_RAZORPAY_BILLING_ENABLED'] !== '1' || this.gateways === undefined) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
    const gateway = this.gateways.billing('RAZORPAY');
    const raw = req.rawBody;
    let evt;
    try {
      if (raw === undefined) throw new BillingWebhookSignatureError('MISSING');
      evt = gateway.verifyWebhook(raw, signature, Math.floor(Date.now() / 1000), { event_id: eventId });
    } catch (e) {
      if (e instanceof BillingWebhookSignatureError) {
        logWebhookRejected(this.log, 'razorpay_billing', e.reason);
        throw new AramoError('AUTH_REQUIRED', 'Webhook signature verification failed', 401, { requestId, details: { reason: e.reason } });
      }
      throw billingHttpError(e, requestId);
    }
    // Failures propagate (5xx) so the provider redelivers; nothing was recorded.
    const result = await this.run(requestId, async () => {
      try {
        return await (this.inbox !== undefined ? this.inbox.receive(evt, SIGN_PRODUCT_KEY) : this.lifecycle.handleEvent(evt, SIGN_PRODUCT_KEY));
      } catch (e) {
        logWebhookFailed(this.log, 'razorpay_billing', e);
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
