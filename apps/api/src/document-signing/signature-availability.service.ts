import { Inject, Injectable } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import { SignatureRoutingRepository, type SignatureProviderKey } from '@aramo/signature-routing';
import { AllowanceService, ESIGN_ENVELOPE_ALLOWANCE, type AllowanceThreshold } from '@aramo/subscription';
import type { SignatureActor } from '@aramo/documents-contracts';

import { EsignServiceApiProvider } from '../sign/esign-service-api.provider.js';
import { isExternalAdapter } from '../esignature-providers/external-signature-adapter.js';

import { SIGNATURE_PROVIDER_REGISTRY, type SignatureProviderRegistry } from './signature-router.js';

// Multi-Provider directive §D — the ONE backend decision for document signing
// availability. RTR, Offer, client-submittal policy authoring and the recruiter
// surfaces all read it; React never re-derives it. Enforcement happens again
// immediately before the actual send (SignatureRoutingService.forNewSend), and
// the Aramo Sign allowance is charged at the native send seam in sign-service.

export const SIGNATURE_UNAVAILABLE_REASONS = [
  'NO_PROVIDER',
  'NOT_SUBSCRIBED',
  'NOT_AUTHORIZED',
  'LIMIT_REACHED',
  'PROVIDER_DISCONNECTED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REFUSED',
] as const;
export type SignatureUnavailableReason = (typeof SIGNATURE_UNAVAILABLE_REASONS)[number];

/** Sending for signature needs both document permissions (request + execute). */
export const SIGNATURE_SEND_SCOPES = ['document:create', 'document:execute'] as const;

export interface SignatureAllowanceView {
  // Commercial Plans Amendment A1 — null on an unlimited plan (usage still counted).
  readonly limit: number | null;
  readonly unlimited: boolean;
  readonly used: number;
  readonly remaining: number | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly threshold: AllowanceThreshold;
}

export interface SignatureAvailability {
  readonly provider: SignatureProviderKey | null;
  readonly available: boolean;
  readonly reason: SignatureUnavailableReason | null;
  /** Aramo Sign only: the tenant's included allowance for the current period. */
  readonly allowance: SignatureAllowanceView | null;
}

@Injectable()
export class SignatureAvailabilityService {
  constructor(
    private readonly routing: SignatureRoutingRepository,
    private readonly entitlements: EntitlementRepository,
    private readonly allowance: AllowanceService,
    @Inject(SIGNATURE_PROVIDER_REGISTRY) private readonly registry: SignatureProviderRegistry,
  ) {}

  /**
   * @param actorScopes the caller's scopes; omit to judge the tenant alone (e.g.
   *   whether a policy may require a signed document at all).
   */
  async evaluate(tenant_id: string, actorScopes?: readonly string[], actor?: SignatureActor): Promise<SignatureAvailability> {
    const { provider } = await this.routing.getSelectedProvider(tenant_id);
    const result = (reason: SignatureUnavailableReason | null, allowance: SignatureAllowanceView | null = null): SignatureAvailability => ({
      provider,
      available: reason === null,
      reason,
      allowance,
    });

    if (actorScopes !== undefined && !SIGNATURE_SEND_SCOPES.every((s) => actorScopes.includes(s))) {
      return result('NOT_AUTHORIZED');
    }
    const port = this.registry.get(provider);
    if (port === undefined) {
      // The selected provider has no working integration in this build.
      return result('PROVIDER_UNAVAILABLE');
    }
    if (provider !== 'aramo_sign') {
      // External providers are governed by the tenant's own provider contract; Aramo
      // checks only that the tenant's connection is healthy.
      const state = isExternalAdapter(port) ? await port.connectionState(tenant_id) : 'NOT_CONNECTED';
      return result(state === 'CONNECTED' ? null : 'PROVIDER_DISCONNECTED');
    }
    const caps = await this.entitlements.getCapabilities(tenant_id);
    if (!caps.has('sign')) return result('NOT_SUBSCRIBED');
    // Addendum S6 (D-12) — over the Sign API transport the ATS never reads Sign's
    // subscription library: availability is Sign-owned, asked with the recruiter's
    // delegation. Without a signed-in recruiter (a tenant-level read) only the
    // entitlement is known; the allowance is decided by Sign at send time.
    if (port instanceof EsignServiceApiProvider) {
      if (actor === undefined) return result(null);
      try {
        const a = await port.availability(tenant_id, actor);
        return result(a.reason, a.allowance === null ? null : { ...a.allowance, threshold: a.allowance.threshold as AllowanceThreshold });
      } catch {
        return result('PROVIDER_UNAVAILABLE');
      }
    }
    const status = await this.allowance.getStatus(tenant_id, ESIGN_ENVELOPE_ALLOWANCE);
    if (!status.subscribed) return result('NOT_SUBSCRIBED');
    const view: SignatureAllowanceView = {
      limit: status.limit,
      unlimited: status.limit === null,
      used: status.used,
      remaining: status.remaining,
      period_start: status.period_start.toISOString(),
      period_end: status.period_end.toISOString(),
      threshold: status.threshold,
    };
    return result(status.remaining !== null && status.remaining <= 0 ? 'LIMIT_REACHED' : null, view);
  }
}
