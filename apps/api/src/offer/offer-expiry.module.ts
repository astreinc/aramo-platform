import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { OfferModule } from './offer.module.js';
import { OfferExpiryProducer } from './offer-expiry.producer.js';
import { OfferExpiryProcessor } from './offer-expiry.processor.js';
import { OFFER_EXPIRY_QUEUE_NAME } from './offer-expiry.queue.constants.js';

// L4 / P6 — the offer auto-expiry worker module (apps/api composition root). Imports
// OfferModule (exports OfferRepository, the sweep authority). BullMQ wiring mirrors
// LifecyclePollModule verbatim: forRootAsync with manualRegistration + lazyConnect +
// a RedisConnectionConfig factory; registerQueue for the one queue with NO repeat
// (the SCHEDULES registrar enqueues the repeat tick). The worker gates on
// RedisConnectionConfig.isConfigured (silent when REDIS_URL is absent — CI / local).
@Module({
  imports: [
    CommonModule,
    OfferModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return { ...baseOpts, connection: { ...cfg.connection, lazyConnect: true } };
        } catch (err) {
          if (err instanceof Error && err.message === 'REDIS_URL is not configured') {
            return {
              ...baseOpts,
              connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
            };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: OFFER_EXPIRY_QUEUE_NAME }),
  ],
  providers: [
    OfferExpiryProducer,
    OfferExpiryProcessor,
    {
      provide: 'OfferExpiryProcessorLogger',
      useFactory: () => createAramoLogger(OfferExpiryProcessor.name),
    },
  ],
})
export class OfferExpiryModule {}
