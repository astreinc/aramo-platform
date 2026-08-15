import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { ConnectorExecutionService } from '@aramo/integration';

import { CONNECTOR_EXECUTION_QUEUE_NAME } from './connector-execution.queue.constants.js';

// T8-CONNECTOR-A — the connector-execution worker (apps/api composition root).
//
// The processor invokes ConnectorExecutionService ONLY — never repositories or
// ImportService directly (Architect ruling: no orchestration bypass). It does
// NOT catch/translate: runDelivery RETURNS every terminal outcome (PROCESSED /
// ALREADY_PROCESSED / UNSUPPORTED / permanent FAILED) so BullMQ does not retry,
// and RE-THROWS only transient failures so BullMQ retries within attempts=5. The
// service's classification stands verbatim.
//
// Lifecycle mirrors the job-distribution / match-sweep processors: manual
// registration gated on RedisConnectionConfig.isConfigured — SILENT when
// REDIS_URL is absent (CI / local dev without Redis). Connector-A registers NO
// repeat/schedule, so the queue is dormant until Connector-B enqueues.
@Processor(CONNECTOR_EXECUTION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ConnectorExecutionProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: ConnectorExecutionService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ConnectorExecutionProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const data = job.data as {
      tenant_id: string;
      connection_id: string;
      requestId?: string;
    };
    await this.service.runDelivery({
      tenant_id: data.tenant_id,
      connection_id: data.connection_id,
      requestId: data.requestId ?? job.id ?? 'connector-job',
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'connector_execution_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
