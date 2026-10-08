#!/usr/bin/env node
// ADR-0033 local-dev runtime — idempotently provision the LocalStack Talent
// Intake transport. Creates (and safely re-applies) the SAME AWS shape the
// production IaC + the AWS-transport integration test use:
//   - a custom EventBridge bus
//   - the source SQS queue (with a redrive policy → consumer DLQ)
//   - two DISTINCT DLQ planes: the SQS consumer DLQ + the EventBridge-target DLQ
//   - the source queue policy allowing events.amazonaws.com:SendMessage
//   - the rule (source=aramo.talent-intake, detail-type=<event>) + target (queue,
//     with a target DeadLetterConfig + retry policy)
// Only the AWS ENDPOINT differs from prod (LocalStack). Safe to run repeatedly:
// same bus/queue/rule/target, no duplicate targets. Writes the resolved source
// queue URL to .local-stack/talent-intake-queue-url for the dev consumer runner.
// DEV-ONLY: not part of the app composition; only tools/local-stack.sh runs it.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const {
  EventBridgeClient,
  CreateEventBusCommand,
  PutRuleCommand,
  PutTargetsCommand,
} = require(ROOT + '/node_modules/@aws-sdk/client-eventbridge');
const {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} = require(ROOT + '/node_modules/@aws-sdk/client-sqs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENDPOINT =
  process.env.TALENT_INTAKE_EVENTBRIDGE_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';
const BUS = process.env.TALENT_INTAKE_EVENT_BUS || 'aramo-local-talent-intake';
const SOURCE_PREFIX = process.env.TALENT_INTAKE_EVENT_SOURCE_PREFIX || 'aramo';
const EVENT_TYPE = 'talent_intake.resume_extraction_requested.v1';
const SRC_QUEUE = 'aramo-local-talent-intake';
const CONSUMER_DLQ = 'aramo-local-talent-intake-consumer-dlq';
const EBTARGET_DLQ = 'aramo-local-talent-intake-ebtarget-dlq';
const RULE = 'aramo-local-talent-intake-extraction-requested';

// LocalStack ignores credentials; explicit dummy creds + the endpoint override
// make it unambiguous these clients NEVER talk to real AWS.
const cfg = {
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};
const eb = new EventBridgeClient(cfg);
const sqs = new SQSClient(cfg);

async function ensureQueue(name, attributes) {
  try {
    const res = await sqs.send(
      new CreateQueueCommand({ QueueName: name, ...(attributes ? { Attributes: attributes } : {}) }),
    );
    return res.QueueUrl;
  } catch (e) {
    const tag = (e && (e.name || '')) + ' ' + (e && (e.message || ''));
    if (/exist/i.test(tag)) {
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      return res.QueueUrl;
    }
    throw e;
  }
}

async function queueArn(url) {
  const res = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  return res.Attributes.QueueArn;
}

(async () => {
  // 1. EventBridge bus (idempotent)
  try {
    await eb.send(new CreateEventBusCommand({ Name: BUS }));
  } catch (e) {
    if (!/exist/i.test((e && (e.name || '')) + ' ' + (e && (e.message || '')))) throw e;
  }

  // 2. DLQ planes + source queue (redrive → consumer DLQ after maxReceiveCount)
  const consumerDlqUrl = await ensureQueue(CONSUMER_DLQ);
  const ebTargetDlqUrl = await ensureQueue(EBTARGET_DLQ);
  const consumerDlqArn = await queueArn(consumerDlqUrl);
  const ebTargetDlqArn = await queueArn(ebTargetDlqUrl);
  const srcUrl = await ensureQueue(SRC_QUEUE, {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: consumerDlqArn, maxReceiveCount: 5 }),
  });
  const srcArn = await queueArn(srcUrl);

  // 3. source queue policy — allow EventBridge to deliver (idempotent re-apply).
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: srcUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowEventBridgeSendMessage',
              Effect: 'Allow',
              Principal: { Service: 'events.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: srcArn,
            },
          ],
        }),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: consumerDlqArn, maxReceiveCount: 5 }),
      },
    }),
  );

  // 4. rule + target (both upserts — no duplicate target on re-run).
  await eb.send(
    new PutRuleCommand({
      Name: RULE,
      EventBusName: BUS,
      EventPattern: JSON.stringify({
        source: [`${SOURCE_PREFIX}.talent-intake`],
        'detail-type': [EVENT_TYPE],
      }),
    }),
  );
  await eb.send(
    new PutTargetsCommand({
      Rule: RULE,
      EventBusName: BUS,
      Targets: [
        {
          Id: 'talent-intake-queue',
          Arn: srcArn,
          DeadLetterConfig: { Arn: ebTargetDlqArn },
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      ],
    }),
  );

  fs.mkdirSync(ROOT + '/.local-stack', { recursive: true });
  fs.writeFileSync(ROOT + '/.local-stack/talent-intake-queue-url', srcUrl + '\n');
  console.log(
    `[provision] OK — bus=${BUS} queue=${srcUrl} rule=${RULE} ` +
      `dlq(consumer)=${CONSUMER_DLQ} dlq(ebtarget)=${EBTARGET_DLQ} (idempotent)`,
  );
})().catch((e) => {
  console.error('[provision] FAILED:', (e && e.message) || e);
  process.exit(1);
});
