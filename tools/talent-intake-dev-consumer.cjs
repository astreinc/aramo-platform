#!/usr/bin/env node
// ADR-0033 local-dev runtime — a DEV-ONLY local execution host for the Talent
// Intake SQS consumer. It is NOT a fallback and NOT part of the production
// composition: production uses AWS SQS → Lambda → processTalentIntakeSqsBatch;
// locally this runner uses LocalStack SQS → processTalentIntakeSqsBatch. BOTH
// converge on the EXACT SAME consumer seam (the adapter + TalentIntakeMessageHandler
// + TalentIntakeExtractionService) — only the execution host differs. It never
// loads in prod: nothing in AppModule/main.js imports it; only tools/local-stack.sh
// starts it.
//
//   LocalStack SQS  ->  dev runner (this)  ->  processTalentIntakeSqsBatch
//                                           ->  TalentIntakeMessageHandler
//                                           ->  TalentIntakeExtractionService
//
// Semantics mirror the Lambda: long-poll the queue, decode+validate+handle each
// record via the adapter, DELETE acked records (processed/skipped), and LEAVE
// retryable records on the queue so the visibility timeout + redrive policy
// (maxReceiveCount → consumer DLQ) behave exactly as in prod.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { NestFactory } = require(ROOT + '/node_modules/@nestjs/core');
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require(ROOT + '/node_modules/@aws-sdk/client-sqs');
const { createAramoLogger } = require(ROOT + '/node_modules/@aramo/common');
const { TalentIntakeMessageHandler } = require(ROOT + '/node_modules/@aramo/talent-record');
const {
  TalentIntakeConsumerModule,
} = require(ROOT + '/dist/apps/api/src/talent-intake-consumer/talent-intake-consumer.module.js');
const {
  processTalentIntakeSqsBatch,
} = require(ROOT + '/dist/apps/api/src/talent-intake-consumer/sqs-lambda.adapter.js');

const logger = createAramoLogger('TalentIntakeDevConsumer');
const REGION = process.env.AWS_REGION || 'us-east-1';
const ENDPOINT =
  process.env.TALENT_INTAKE_EVENTBRIDGE_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';

function resolveQueueUrl() {
  if (process.env.TALENT_INTAKE_SQS_QUEUE_URL) return process.env.TALENT_INTAKE_SQS_QUEUE_URL;
  const f = ROOT + '/.local-stack/talent-intake-queue-url';
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

(async () => {
  const queueUrl = resolveQueueUrl();
  if (!queueUrl) {
    logger.error({
      event: 'talent_intake_dev_consumer_misconfigured',
      reason: 'no TALENT_INTAKE_SQS_QUEUE_URL and no .local-stack/talent-intake-queue-url (run provisioning first)',
    });
    process.exit(1);
  }
  const sqs = new SQSClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const ctx = await NestFactory.createApplicationContext(TalentIntakeConsumerModule, {
    bufferLogs: false,
    abortOnError: true,
  });
  await ctx.enableShutdownHooks();
  const handler = ctx.get(TalentIntakeMessageHandler, { strict: false });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.log({ event: 'talent_intake_dev_consumer_stopping', signal });
    try {
      await ctx.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log({ event: 'talent_intake_dev_consumer_started', queue_url: queueUrl, endpoint: ENDPOINT });

  while (!stopping) {
    let messages = [];
    try {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      messages = res.Messages || [];
    } catch (err) {
      if (!stopping) {
        logger.warn({
          event: 'talent_intake_dev_consumer_receive_failed',
          reason: (err && err.message) || String(err),
        });
        await new Promise((r) => setTimeout(r, 2000));
      }
      continue;
    }
    if (messages.length === 0) continue;

    const records = messages.map((m) => ({
      messageId: m.MessageId || 'unknown',
      body: m.Body || '',
      attributes: { ApproximateReceiveCount: m.Attributes && m.Attributes.ApproximateReceiveCount },
    }));
    const response = await processTalentIntakeSqsBatch(records, handler, logger);
    const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));

    for (const m of messages) {
      // processed / skipped → ack (DELETE). retryable → leave on the queue so the
      // visibility timeout + redrive (maxReceiveCount → consumer DLQ) apply.
      if (m.MessageId && !failed.has(m.MessageId) && m.ReceiptHandle) {
        try {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (err) {
          logger.warn({
            event: 'talent_intake_dev_consumer_delete_failed',
            message_id: m.MessageId,
            reason: (err && err.message) || String(err),
          });
        }
      }
    }
  }
})().catch((e) => {
  logger.error({ event: 'talent_intake_dev_consumer_fatal', reason: (e && e.message) || String(e) });
  process.exit(1);
});
