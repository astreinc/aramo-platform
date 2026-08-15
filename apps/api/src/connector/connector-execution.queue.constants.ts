// T8-CONNECTOR-A — connector-execution queue constants (apps/api composition
// root). One source of truth for BullModule.registerQueue, the @Processor
// decorator, and any future enqueue site. Placed in apps/api (NOT the lib) per
// the processors-in-app ruling + the job-distribution precedent.
//
// Bounded retry policy (directive §17, Architect ruling): attempts = 5 with a
// bounded exponential backoff. There is DELIBERATELY NO repeat/schedule config —
// Connector-A defines NO polling cadence (transport scheduling belongs to
// Connector-B). In Connector-A the queue is dormant: no producer enqueues jobs
// (no provider selected); the worker + retry policy exist so the infrastructure
// is ready and testable.
export const CONNECTOR_EXECUTION_QUEUE_NAME = 'connector-execution' as const;

export const CONNECTOR_EXECUTION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: false,
} as const;
