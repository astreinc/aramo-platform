import { deriveCommercialMetrics as deriveCanonical, type CommercialMetrics } from '@aramo/common';

import type { Prisma } from '../../../prisma/generated/client/client.js';

// Lane 7 / L7-D — placement's Prisma.Decimal-typed ADAPTER over the ONE canonical
// commercial arithmetic (spread/margin/markup) in @aramo/common. Kept so placement's
// call sites keep passing Prisma.Decimal with no ripple, while the actual math is
// single-sourced across the assignment ledger (here) and the requisition compensation
// plan — the two can no longer drift. The money is Decimal(12,2), so toFixed(2) is
// lossless. See @aramo/common commercial-metrics for the formula + zero-denominator rule.
export type { CommercialMetrics };

export function deriveCommercialMetrics(
  pay: Prisma.Decimal,
  bill: Prisma.Decimal,
): CommercialMetrics {
  return deriveCanonical(pay.toFixed(2), bill.toFixed(2));
}
