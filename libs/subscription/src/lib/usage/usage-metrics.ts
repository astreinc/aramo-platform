import { assertMeteredKeyOf, assertProductKey, ProductContextError, type ProductKey } from '../product-registry.js';

// CCP-D1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D1; architecture metering
// prerequisite "a metric registry mapping event types to business metrics") — the code mirror
// of the governed DB registry subscription."UsageMetric" (seeded by migration 20261025240000,
// UPDATE / DELETE rejected). A test pins the two together. Widening is an additive migration
// plus this list; a metric for a product outside the CCP-A4 registry is refused (PBD §7.1).
//
// A metric counts AllowanceUsage rows of one allowance key (source ALLOWANCE_USAGE). Its
// usage_event_type is the metering UsageEvent a CONSUMED SEND row writes in the same
// transaction (allowance.service.ts consume), used for the raw-event cross-check. There is no
// price, rate or unit price here: usage-based pricing is out of scope (PBD D1 row "Out").
// The Sign values equal ESIGN_ENVELOPE_ALLOWANCE / ESIGN_ENVELOPE_SENT_EVENT (src/index.ts),
// pinned by the D1 spec.

export const USAGE_METRIC_SOURCES = ['ALLOWANCE_USAGE'] as const;
export type UsageMetricSource = (typeof USAGE_METRIC_SOURCES)[number];

export interface UsageMetricDefinition {
  readonly metric_key: string;
  readonly product_key: ProductKey;
  readonly source: UsageMetricSource;
  readonly allowance_key: string;
  readonly usage_event_type: string | null;
  readonly unit: string;
}

export const USAGE_METRICS: readonly UsageMetricDefinition[] = [
  {
    metric_key: 'sign.envelopes',
    product_key: 'sign',
    source: 'ALLOWANCE_USAGE',
    allowance_key: 'sign.envelopes',
    usage_event_type: 'sign.envelope.sent',
    unit: 'envelope',
  },
];

/** The registered metrics of one product (fail closed on an unregistered product). */
export function usageMetricsOf(product_key: ProductKey): UsageMetricDefinition[] {
  assertProductKey(product_key);
  return USAGE_METRICS.filter((m) => m.product_key === product_key);
}

/** The metric `metric_key` of `product_key`; throws when it is not registered for that product. */
export function usageMetricOf(product_key: ProductKey, metric_key: string): UsageMetricDefinition {
  const m = usageMetricsOf(product_key).find((x) => x.metric_key === metric_key);
  if (m === undefined) throw new ProductContextError(`usage metric ${metric_key} is not registered for product ${product_key}`);
  assertMeteredKeyOf(product_key, m.allowance_key);
  return m;
}
