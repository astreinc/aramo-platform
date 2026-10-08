import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAramoLogger } from '@aramo/common';
import { TalentIntakeMessageHandler } from '@aramo/talent-record';

import { TalentIntakeConsumerModule } from './talent-intake-consumer.module.js';
import { processTalentIntakeSqsBatch } from './sqs-lambda.adapter.js';
import type { SqsBatchResponse, SqsEventLike } from './sqs-event.types.js';

// ADR-0033 — the AWS Lambda ENTRYPOINT for the Talent Intake SQS consumer. Owns
// ONLY runtime concerns: a cold-start-cached Nest application context, delegating
// to the adapter for batch iteration + decode/validate + ReportBatchItemFailures,
// and infrastructure logging. It owns NO intake state transitions, CAS,
// extraction logic, tenant authority, business idempotency, or retries beyond
// SQS/Lambda semantics — those live below the runtime boundary in
// TalentIntakeMessageHandler → TalentIntakeExtractionService.

const logger = createAramoLogger('TalentIntakeLambda');

// Cached across warm invocations (cold-start reuse). The consumer context holds
// NO publisher/drain — the Lambda can never become a second outbox publisher.
let cachedContext: INestApplicationContext | null = null;
let cachedHandler: TalentIntakeMessageHandler | null = null;

async function resolveHandler(): Promise<TalentIntakeMessageHandler> {
  if (cachedHandler !== null) return cachedHandler;
  if (cachedContext === null) {
    cachedContext = await NestFactory.createApplicationContext(TalentIntakeConsumerModule, {
      bufferLogs: false,
      abortOnError: true,
    });
    await cachedContext.enableShutdownHooks();
  }
  const resolved = cachedContext.get(TalentIntakeMessageHandler, { strict: false });
  cachedHandler = resolved;
  return resolved;
}

// SQS → Lambda handler. Returns the partial-batch response so ONE failed record
// does not replay the already-successful records in the batch.
export async function handler(event: SqsEventLike): Promise<SqsBatchResponse> {
  const messageHandler = await resolveHandler();
  const response = await processTalentIntakeSqsBatch(event.Records, messageHandler, logger);
  if (response.batchItemFailures.length > 0) {
    logger.warn({
      event: 'talent_intake_lambda_batch_partial_failure',
      received: event.Records.length,
      failed: response.batchItemFailures.length,
    });
  }
  return response;
}
