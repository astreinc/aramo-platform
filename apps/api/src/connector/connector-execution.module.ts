import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { IntegrationModule } from '@aramo/integration';

import { RequisitionIntegrationModule } from '../requisition-integration/requisition-integration.module.js';

import { ConnectorExecutionProcessor } from './connector-execution.processor.js';
import {
  CONNECTOR_EXECUTION_JOB_OPTIONS,
  CONNECTOR_EXECUTION_QUEUE_NAME,
} from './connector-execution.queue.constants.js';

// T8-CONNECTOR-A — the connector-execution worker module (apps/api composition
// root, processors-in-app ruling). Imports IntegrationModule for
// ConnectorExecutionService (the ONLY thing the processor invokes). BullMQ wiring
// mirrors JobDistributionSyncModule: forRootAsync with manualRegistration +
// lazyConnect + a RedisConnectionConfig factory; registerQueue for the one queue
// with a BOUNDED retry policy (attempts=5, exponential backoff) and NO repeat.
@Module({
  imports: [
    CommonModule,
    IntegrationModule,
    // CB-D2-A1 — the post-establishment identity handoff the processor invokes.
    RequisitionIntegrationModule,
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
    BullModule.registerQueue({
      name: CONNECTOR_EXECUTION_QUEUE_NAME,
      defaultJobOptions: CONNECTOR_EXECUTION_JOB_OPTIONS,
    }),
  ],
  providers: [
    ConnectorExecutionProcessor,
    {
      provide: 'ConnectorExecutionProcessorLogger',
      useFactory: () => createAramoLogger(ConnectorExecutionProcessor.name),
    },
  ],
})
export class ConnectorExecutionModule {}
