import { Injectable, Logger } from '@nestjs/common';
import { OfferRepository } from '@aramo/placement';

import { OFFER_EXPIRY_SYSTEM_ACTOR } from './offer-expiry.queue.constants.js';

// L4 / P6 — the governed offer auto-expiry producer. Transitions every overdue
// SENT/NEGOTIATION offer (offer_expires_at < now) to EXPIRED via the repository's
// legality-enforced, CAS/idempotent sweep. Scheduling (the BullMQ SCHEDULES repeat
// tick) is Redis-gated in the processor; this producer is a plain service so the
// integration proofs drive `sweep` directly (no Redis), passing a fixed `now`.
@Injectable()
export class OfferExpiryProducer {
  private readonly logger = new Logger(OfferExpiryProducer.name);

  constructor(private readonly offers: OfferRepository) {}

  async sweep(now: Date = new Date()): Promise<{ expired: number }> {
    const result = await this.offers.expireOverdueOffers(now, OFFER_EXPIRY_SYSTEM_ACTOR);
    if (result.expired > 0) {
      this.logger.log(`offer auto-expiry: ${result.expired} offer(s) transitioned to EXPIRED`);
    }
    return result;
  }
}
