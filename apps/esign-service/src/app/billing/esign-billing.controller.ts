import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard, IdentityRepository } from '@aramo/identity';
import {
  BILLING_PROVIDER_PORT,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingRefusedError,
  BillingWebhookSignatureError,
  ESIGN_ENVELOPE_ALLOWANCE,
  SubscriptionLifecycleService,
  approvedLegalDocument,
  type WebhookResult,
} from '@aramo/subscription';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';

import { ESIGN_READ_SCOPE, SenderContextService } from '../sender/sender-context.service.js';

import { EsignOwnerActivationService } from './esign-owner-activation.service.js';

// Aramo Sign launch — self-service billing on esign.aramo.ai (v1/esign/billing).
//
//   GET  plans            sellable plans (esign consumer + `esign` capability)
//   GET  account          plan, status, period, usage (+ Sign read OR org settings)
//   POST checkout         start a provider checkout       (org settings authority)
//   POST portal           open the provider billing portal (org settings authority)
//   POST webhook/stripe   provider → Aramo; NO session: authenticity is the
//                         verified Stripe-Signature over the raw body only.
// tenant_id and the acting user come only from the verified auth context. The
// success / cancel / return URLs are server-built (never taken from the body):
// no open redirect, and the browser never asserts a payment.

export const BILLING_MANAGE_SCOPE = 'tenant:admin:settings';

function BillingBoundary(scope?: string): MethodDecorator {
  return applyDecorators(
    UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard),
    RequireCapability('esign'),
    ...(scope !== undefined ? [RequireScopes(scope)] : []),
  );
}

/** Optional "Contact sales" link for Enterprise (SIGN_SALES_CONTACT_URL, http(s) only). */
function salesContactUrl(): string | null {
  const v = process.env['SIGN_SALES_CONTACT_URL']?.trim();
  return v !== undefined && /^(https?:|mailto:)/.test(v) ? v : null;
}

function consoleBase(): string {
  return (process.env['ESIGN_SENDER_WEB_BASE_URL'] ?? 'https://esign.aramo.ai').trim().replace(/\/+$/, '');
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
    if (e.reason === 'TERMS_NOT_APPROVED') {
      return new AramoError('ESIGN_BILLING_UNAVAILABLE', 'Online billing is not available right now', 503, { requestId, details: { reason: e.reason } });
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

@Controller('v1/esign/billing')
@UseFilters(AramoExceptionFilter)
export class EsignBillingController {
  private readonly log = new Logger(EsignBillingController.name);

  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
    private readonly owners: EsignOwnerActivationService,
    private readonly ctx: SenderContextService,
    private readonly identity: IdentityRepository,
  ) {}

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
        plans: await this.lifecycle.catalog(auth.tenant_id),
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
      const can_manage = scopes.has(BILLING_MANAGE_SCOPE);
      if (!can_manage && !scopes.has(ESIGN_READ_SCOPE)) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Viewing the plan needs Sign access or organization settings authority', 403, {
          requestId,
          details: { reason: 'billing_read_scope_missing' },
        });
      }
      const kind = await this.ctx.tenantKind(auth.tenant_id, requestId);
      const view = await this.lifecycle.account(auth.tenant_id, ESIGN_ENVELOPE_ALLOWANCE);
      // Heal path: the subscribing owner whose role grant did not land at the
      // webhook (e.g. a transient identity failure) receives it on their next read.
      const owner = await this.lifecycle.sendingOwner(auth.tenant_id);
      if (owner === auth.sub && !scopes.has(ESIGN_READ_SCOPE)) await this.owners.activate(auth.tenant_id, auth.sub, requestId);
      return {
        ...view,
        tenant_kind: kind,
        // PERSONAL commercial sending stays deferred (fixed boundary).
        self_service_eligible: kind === 'BUSINESS',
        can_manage_billing: can_manage && kind === 'BUSINESS',
      };
    });
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @BillingBoundary(BILLING_MANAGE_SCOPE)
  checkout(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { plan_key?: unknown; accept_terms?: unknown }) {
    return this.run(requestId, async () => {
      await this.ctx.assertCanAuthor(auth, requestId);
      if (typeof body?.plan_key !== 'string' || body.plan_key.length === 0 || body.plan_key.length > 100) {
        throw new AramoError('VALIDATION_ERROR', 'plan_key is required', 400, { requestId });
      }
      const user = await this.identity.findUserById(auth.sub);
      if (user?.email == null) throw new AramoError('VALIDATION_ERROR', 'Your account has no email address', 400, { requestId });
      const base = consoleBase();
      return this.lifecycle.startCheckout({
        tenant_id: auth.tenant_id,
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
  @BillingBoundary(BILLING_MANAGE_SCOPE)
  portal(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.lifecycle.portal(auth.tenant_id, `${consoleBase()}/sign/settings/billing`));
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
    const result = await this.run(requestId, () => this.lifecycle.handleEvent(evt));
    if (result.outcome === 'APPLIED' && result.activated_owner_user_id !== undefined && result.tenant_id !== null) {
      const outcome = await this.owners.activate(result.tenant_id, result.activated_owner_user_id, requestId);
      this.log.log(`subscription opened for tenant ${result.tenant_id}; subscribing-owner activation ${outcome}`);
    }
    return { received: true, outcome: result.outcome };
  }
}
