import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { type EsignDomainEvent, type EventPublisherPort, LocalEventPublisher } from '@aramo/esign';

// DOC-4 (R-4-7) — the AWS-SNS operational event publisher. Publishes the
// refs-only executed-envelope event (no bytes/PII) to the configured topic with
// tenant + correlation attributes for the idempotent apps/api consumer. Bound by
// the composition root ONLY when a topic ARN is configured; otherwise the local
// no-op publisher is used (DARK default — local/CI/unwired-prod). Real topic +
// subscription are provisioned in IaC from the Mac (DEPLOY=NO).

export class SnsEventPublisher implements EventPublisherPort {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {}

  async publish(event: EsignDomainEvent): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          event_type: { DataType: 'String', StringValue: event.event_type },
          tenant_id: { DataType: 'String', StringValue: event.tenant_id },
          correlation_id: { DataType: 'String', StringValue: event.correlation_id },
        },
      }),
    );
  }
}

// Env-gated factory — SNS when ESIGN_EVENT_BUS_TOPIC_ARN is set (bus is DARK by
// default), else the local no-op publisher.
export function eventPublisherFromEnv(env: NodeJS.ProcessEnv): EventPublisherPort {
  const topicArn = env['ESIGN_EVENT_BUS_TOPIC_ARN'];
  if (topicArn === undefined || topicArn === '') return new LocalEventPublisher();
  const region = env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
  const client = new SNSClient(region !== undefined ? { region } : {});
  return new SnsEventPublisher(client, topicArn);
}
