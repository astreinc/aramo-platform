import type { BillingProviderCommandPort, BillingProviderPort, BillingProviderSeatPort, WebBillingProviderKey } from './billing-provider.port.js';

// India Billing Regions + Razorpay (Implementation Directive v1.0 LOCKED §4.3) — the web billing
// gateways by provider key. Stripe binds exactly the instances bound to BILLING_PROVIDER_PORT /
// BILLING_PROVIDER_COMMAND_PORT / BILLING_PROVIDER_SEAT_PORT (the US path is unchanged); Razorpay binds
// its adapter (isConfigured() = its credentials present, G-2). New code that must reach Razorpay goes
// through this registry; BILLING_PROVIDER_PORT stays Stripe.

export const BILLING_GATEWAY_REGISTRY = Symbol('BILLING_GATEWAY_REGISTRY');

export interface BillingGatewayRegistry {
  /** The gateway's billing port; throws for an unbound key. */
  billing(p: WebBillingProviderKey): BillingProviderPort;
  commands(p: WebBillingProviderKey): BillingProviderCommandPort | null;
  seats(p: WebBillingProviderKey): BillingProviderSeatPort | null;
  configured(p: WebBillingProviderKey): boolean;
}

export interface BillingGatewayBinding {
  billing: BillingProviderPort;
  commands?: BillingProviderCommandPort | null;
  seats?: BillingProviderSeatPort | null;
}

export class UnboundBillingGatewayError extends Error {
  constructor(public readonly provider: string) {
    super(`no billing gateway is bound for ${provider}`);
    this.name = 'UnboundBillingGatewayError';
  }
}

/** The static registry: one binding per web provider key (each binding's ports report that provider). */
export class StaticBillingGatewayRegistry implements BillingGatewayRegistry {
  private readonly bindings: ReadonlyMap<WebBillingProviderKey, BillingGatewayBinding>;

  constructor(bindings: Partial<Record<WebBillingProviderKey, BillingGatewayBinding>>) {
    const m = new Map<WebBillingProviderKey, BillingGatewayBinding>();
    for (const [key, b] of Object.entries(bindings) as Array<[WebBillingProviderKey, BillingGatewayBinding | undefined]>) {
      if (b === undefined) continue;
      if (b.billing.provider !== key || (b.commands != null && b.commands.provider !== key) || (b.seats != null && b.seats.provider !== key)) {
        throw new Error(`billing gateway binding for ${key} reports another provider`);
      }
      m.set(key, b);
    }
    this.bindings = m;
  }

  billing(p: WebBillingProviderKey): BillingProviderPort {
    const b = this.bindings.get(p);
    if (b === undefined) throw new UnboundBillingGatewayError(p);
    return b.billing;
  }

  commands(p: WebBillingProviderKey): BillingProviderCommandPort | null {
    return this.bindings.get(p)?.commands ?? null;
  }

  seats(p: WebBillingProviderKey): BillingProviderSeatPort | null {
    return this.bindings.get(p)?.seats ?? null;
  }

  configured(p: WebBillingProviderKey): boolean {
    return this.bindings.get(p)?.billing.isConfigured() === true;
  }
}
