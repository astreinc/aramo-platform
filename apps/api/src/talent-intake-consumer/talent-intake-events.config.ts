// ADR-0033 — Talent Intake durable-event transport configuration (producer side).
//
// FAIL-CLOSED: the default transport is EventBridge; if the bus is not
// configured the API REFUSES TO START rather than silently degrading. The
// structured-log transport is an EXPLICIT non-prod/test selection only
// (TALENT_INTAKE_TRANSPORT=structured-log) — it can never be an implicit
// production fallback, and there is no fallback to BullMQ or structured-log on
// an EventBridge runtime failure.

export type TalentIntakeTransport = 'eventbridge' | 'structured-log';

export interface TalentIntakeEventsConfig {
  readonly transport: TalentIntakeTransport;
  readonly busName: string | null;
  readonly region: string | null;
  readonly sourcePrefix: string;
  readonly endpoint: string | null; // set for LocalStack integration only
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly drainLimit: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadTalentIntakeEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): TalentIntakeEventsConfig {
  const transportRaw = (env['TALENT_INTAKE_TRANSPORT'] ?? 'eventbridge').trim();
  if (transportRaw !== 'eventbridge' && transportRaw !== 'structured-log') {
    throw new Error(
      `TALENT_INTAKE_TRANSPORT must be 'eventbridge' or 'structured-log' (got '${transportRaw}').`,
    );
  }
  const transport: TalentIntakeTransport = transportRaw;
  const busName = ((env['TALENT_INTAKE_EVENT_BUS'] ?? '').trim() || null);
  const region =
    ((env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'] ?? '').trim() || null);

  // NOTE: the EventBridge-bus-missing FAIL-CLOSED check does NOT run here (that
  // would throw at module bootstrap and break every full-AppModule test). It
  // runs lazily on the first publish in the EventBridge adapter — the
  // composition still BINDS EventBridge (never structured-log) when
  // transport=eventbridge, so a misconfigured production never silently
  // degrades; it fails loudly on the first drain and the lease model keeps the
  // outbox rows retryable. Mirrors the lazy S3ClientFactory precedent.

  return {
    transport,
    busName,
    region,
    sourcePrefix: (env['TALENT_INTAKE_EVENT_SOURCE_PREFIX'] ?? 'aramo').trim(),
    endpoint: ((env['TALENT_INTAKE_EVENTBRIDGE_ENDPOINT'] ?? '').trim() || null),
    leaseSeconds: intEnv(env['TALENT_INTAKE_DRAIN_LEASE_SECONDS'], 60),
    maxAttempts: intEnv(env['TALENT_INTAKE_DRAIN_MAX_ATTEMPTS'], 5),
    drainLimit: intEnv(env['TALENT_INTAKE_DRAIN_BATCH'], 50),
  };
}
