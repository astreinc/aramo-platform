import { Injectable } from '@nestjs/common';
import { countSignSeatsTx, type SeatLimitCheck, type SeatLimitPort, type SeatLimitTx } from '@aramo/identity';
import { SIGN_PRODUCT_KEY, SeatBillingService } from '@aramo/subscription';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2.3 — the apps/api
// SeatLimitPort: the limit is the tenant's purchased seats on a per-seat Sign version (libs/subscription),
// the count is the S-4 seat count read inside the caller's identity transaction (under its tenant-row lock).
// libs/identity and libs/subscription stay unlinked: the composition happens here, in the app.
@Injectable()
export class SignSeatLimitAdapter implements SeatLimitPort {
  constructor(private readonly seats: SeatBillingService) {}

  async check(tenant_id: string, tx: SeatLimitTx): Promise<SeatLimitCheck> {
    const purchased = await this.seats.seatLimit(tenant_id, SIGN_PRODUCT_KEY);
    if (purchased === null) return { limited: false };
    return { limited: true, used: await countSignSeatsTx(tx, tenant_id), purchased };
  }
}
