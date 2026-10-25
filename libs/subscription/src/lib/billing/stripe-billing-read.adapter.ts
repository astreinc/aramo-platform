import { Injectable } from '@nestjs/common';

import {
  type BillingProviderReadPort,
  BillingProviderUnavailableError,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
  type ProviderSubscriptionState,
} from './billing-provider.port.js';
import { STRIPE_API_VERSION, stripeSubscriptionState } from './stripe-billing.provider.js';
import {
  wireInvoiceListPath,
  wireInvoiceState,
  wireListData,
  wirePortalConfigurationPath,
  wirePortalConfigurationState,
  wireSubscriptionQuery,
} from './stripe-wire.js';

// CCP-C3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C3: "a read-only adapter inside
// the Stripe wire boundary … Out: any write to Stripe") — the READ-ONLY Stripe adapter.
//
// Read-only by construction:
//   - It is its own class. It does not extend or delegate to StripeBillingProvider, which holds
//     the checkout, portal-session, account and command writes.
//   - Its one HTTP entry (`read`) fixes the method to GET, sends no body and no idempotency key,
//     and takes only paths built by the wire translators.
//   - Its public surface is exactly STRIPE_READ_ADAPTER_METHODS (asserted by
//     ccp-c3-billing-read.spec.ts, together with a source scan for any other HTTP verb).
// Stripe's own identifiers stay in stripe-wire.ts (the existing vocabulary exemption); this file
// only calls the translators.
//
// Config: the existing STRIPE_SECRET_KEY / STRIPE_API_BASE. In production only sign-service is
// given the key today (docker-compose.prod.yml); without it this adapter reports itself
// unconfigured and the read routes answer their designed BILLING_UNAVAILABLE state.

/** The complete public surface of the read adapter (besides `provider`). */
export const STRIPE_READ_ADAPTER_METHODS = ['isConfigured', 'mode', 'retrieveSubscription', 'listSubscriptionInvoices', 'retrievePortalConfiguration'] as const;

@Injectable()
export class StripeBillingReadAdapter implements BillingProviderReadPort {
  readonly provider = 'STRIPE' as const;

  private secretKey(): string | undefined {
    const k = process.env['STRIPE_SECRET_KEY'];
    return k === undefined || k.trim() === '' ? undefined : k.trim();
  }

  private base(): string {
    return (process.env['STRIPE_API_BASE'] ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  mode(): 'test' | 'live' {
    const k = this.secretKey() ?? '';
    return k.startsWith('sk_live_') || k.startsWith('rk_live_') ? 'live' : 'test';
  }

  /** A read needs the API key only (no webhook secret). */
  isConfigured(): boolean {
    return this.secretKey() !== undefined;
  }

  /** The ONLY provider call: GET, no body. A 404 is returned as null; any other failure throws. */
  private async read(path: string): Promise<Record<string, unknown> | null> {
    const key = this.secretKey();
    if (key === undefined) throw new BillingProviderUnavailableError('STRIPE_SECRET_KEY is not configured');
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION },
      });
    } catch (err) {
      throw new BillingProviderUnavailableError(`network: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404) return null;
    if (!res.ok) {
      const message = ((json['error'] as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`).slice(0, 300);
      throw new BillingProviderUnavailableError(`stripe read ${path.split('?')[0]}: ${message}`, res.status === 429 || res.status >= 500);
    }
    return json;
  }

  async retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState> {
    const s = await this.read(`/v1/subscriptions/${encodeURIComponent(subscription_ref)}?${wireSubscriptionQuery()}`);
    if (s === null) throw new BillingProviderUnavailableError('provider subscription not found', false);
    return stripeSubscriptionState(s);
  }

  async listSubscriptionInvoices(subscription_ref: string, limit: number): Promise<ProviderInvoiceState[]> {
    const page = await this.read(wireInvoiceListPath(subscription_ref, limit));
    if (page === null) return [];
    return wireListData(page).map((o) => ({ provider: 'STRIPE' as const, ...wireInvoiceState(o) }));
  }

  async retrievePortalConfiguration(configuration_ref: string): Promise<ProviderPortalConfigurationState | null> {
    const c = await this.read(wirePortalConfigurationPath(configuration_ref));
    return c === null ? null : { provider: 'STRIPE', ...wirePortalConfigurationState(c) };
  }
}
