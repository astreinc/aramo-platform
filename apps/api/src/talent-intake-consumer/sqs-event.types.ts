// Minimal SQS/Lambda shapes for the Talent Intake consumer adapter. Local (not
// @types/aws-lambda) to keep the AWS-runtime surface tiny and self-contained.
// These AWS-shaped types live ONLY in the adapter layer — never in the domain
// handler (ADR-0033 Decision 3 runtime-neutrality).

export interface SqsRecordLike {
  readonly messageId: string;
  readonly body: string;
  readonly attributes?: {
    readonly ApproximateReceiveCount?: string;
  };
}

export interface SqsEventLike {
  readonly Records: readonly SqsRecordLike[];
}

export interface SqsBatchItemFailure {
  readonly itemIdentifier: string;
}

// The Lambda SQS partial-batch response contract: only the listed message ids
// are retried; everything else is treated as successfully processed and deleted.
export interface SqsBatchResponse {
  readonly batchItemFailures: SqsBatchItemFailure[];
}
