import { ConnectionServiceError } from '../connection/integration-connection.service.js';
import { ConnectorSecretResolutionError } from '../secrets/connector-secret-resolver.js';

// T8-CONNECTOR-A — connector execution failure taxonomy (directive §17, Architect
// check #4). Transient failures retry within a FIXED bound; everything else —
// invalid config, mapping/validation rejection, canonical rejection that cannot
// change on retry, and the UNSUPPORTED_EXISTING_REQUISITION_UPDATE terminal
// outcome — must NOT retry. Unknown errors default to PERMANENT so a permanently
// broken connection never becomes a queue storm. The DB delivery ledger remains
// authoritative even if BullMQ redelivers a job.

/** Bounded BullMQ retry policy (directive §17 — no silent infinite retry). */
export const CONNECTOR_QUEUE_ATTEMPTS = 5;
export const CONNECTOR_QUEUE_BACKOFF = { type: 'exponential' as const, delay: 1_000 };

/** A retryable transport/infra failure (timeout, provider unavailable, throttling, SM backend blip). */
export class ConnectorTransientError extends Error {
  constructor(
    readonly reason:
      | 'timeout'
      | 'provider_unavailable'
      | 'throttled'
      | 'secret_backend_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorTransientError';
  }
}

export type FailureClass = 'transient' | 'permanent';

/**
 * Classify a thrown execution error. ConnectorTransientError → transient; typed
 * config/secret/service errors → permanent; anything else → permanent (default
 * no-retry to prevent queue storms on a permanently invalid connection).
 */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof ConnectorTransientError) {
    return 'transient';
  }
  if (
    err instanceof ConnectorSecretResolutionError ||
    err instanceof ConnectionServiceError
  ) {
    return 'permanent';
  }
  return 'permanent';
}

/** True iff the error should be re-thrown so BullMQ retries (within the bound). */
export function shouldRetry(err: unknown): boolean {
  return classifyFailure(err) === 'transient';
}
