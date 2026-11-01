// Sign usage / metered billing (Feature Parity D-2, A1) — the provider boundary for REPORTING
// recorded usage to the billing provider's metered prices. Aramo's UsageLedgerEntry stays the
// usage authority; the provider receives one meter event per ledger entry, keyed by the entry id
// so a redelivery can never be counted twice.
//
// Stripe (REST, no SDK; API version pinned by STRIPE_API_VERSION 2024-06-20): Billing Meter
// Events, POST /v1/billing/meter_events. The legacy subscription-item usage records endpoint is
// not used (it is retired in later API versions). The Stripe adapter implements this port.

export const USAGE_METER_REPORT_PORT = 'USAGE_METER_REPORT_PORT';

export interface MeterEventReport {
  /** The provider meter's event name (PlanVersionUnitPrice.provider_meter_event). */
  readonly event_name: string;
  /** The tenant's provider billing account (TenantSubscription.billing_account_ref). */
  readonly account_ref: string;
  /** The quantity (a positive integer). */
  readonly value: number;
  /** Idempotent identity at the provider: the ledger entry id. */
  readonly identifier: string;
  /** When the usage occurred. */
  readonly occurred_at: Date;
}

export interface UsageMeterReportPort {
  readonly provider: 'STRIPE';
  /** 'live' for a live-mode key (reporting is held: live billing is not authorized). */
  mode(): 'test' | 'live';
  /** A provider key is configured. */
  meterReportingConfigured(): boolean;
  /**
   * Report one meter event. Resolves with the provider's identifier on acceptance. Throws
   * BillingProviderUnavailableError (retryable for network / 429 / 5xx; not for a 4xx refusal).
   */
  reportMeterEvent(event: MeterEventReport): Promise<{ provider_event_ref: string }>;
}
