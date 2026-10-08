import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger, type AramoLogger } from '@aramo/common';
import {
  TalentEvidenceModule,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';
import {
  OUTBOX_PUBLISHER_PORT,
  type EnvelopeDefaults,
  type LeaseSafeOutboxRepository,
  type OutboxPublisherPort,
} from '@aramo/events';
import {
  LeaseSafeOutboxDrainService,
  StructuredLogOutboxPublisher,
} from '@aramo/outbox-publisher';

import {
  loadTalentIntakeEventsConfig,
  type TalentIntakeEventsConfig,
} from './talent-intake-events.config.js';
import { LazyEventBridgeOutboxPublisher } from './lazy-eventbridge-outbox-publisher.js';
import { TalentIntakeOutboxDrainWorker } from './talent-intake-outbox-drain.worker.js';

// ADR-0033 — the Talent Intake PUBLISHER composition (runs in apps/api). The SOLE
// intake transport producer: the lease-safe drain reads TalentIntakeOutboxEvent
// and publishes the canonical envelope via OUTBOX_PUBLISHER_PORT → EventBridge.
// NO handler/extraction (that is the consumer/Lambda side); NO BullMQ intake
// path. The drain worker is Redis-INDEPENDENT (Redis-down never stalls intake)
// and multi-replica-safe via the lease FOR UPDATE SKIP LOCKED claim.

const CONFIG_TOKEN = 'TalentIntakeEventsConfig';
const LEASE_REPO_TOKEN = 'LEASE_SAFE_OUTBOX_REPOSITORY';

// Fallbacks for outbox rows written without explicit envelope columns (the
// upload-path completeUploadWithOutbox writes event_payload {draft_id,
// correlation_id}); buildEventEnvelope applies these when a column is null.
const ENVELOPE_DEFAULTS: EnvelopeDefaults = {
  source: 'talent-intake',
  event_version: 'v1',
  subjectTypeFor: () => 'talent_intake_draft',
  subjectIdFor: (row) =>
    String((row.event_payload as { draft_id?: string } | null)?.draft_id ?? row.id),
  correlationIdFor: (row) => {
    const c = (row.event_payload as { correlation_id?: string } | null)?.correlation_id;
    return typeof c === 'string' ? c : null;
  },
};

@Module({
  imports: [CommonModule, TalentEvidenceModule],
  providers: [
    // Transport config (fail-closed is enforced lazily on first publish).
    { provide: CONFIG_TOKEN, useFactory: (): TalentIntakeEventsConfig => loadTalentIntakeEventsConfig() },

    // OUTBOX_PUBLISHER_PORT — EventBridge (lazy, fail-closed) in production;
    // structured-log ONLY on an explicit non-prod selection. No implicit / BullMQ
    // fallback.
    { provide: 'OutboxPublisherPortLogger', useFactory: () => createAramoLogger('TalentIntakeOutboxPublisher') },
    {
      provide: OUTBOX_PUBLISHER_PORT,
      useFactory: (config: TalentIntakeEventsConfig, logger: AramoLogger): OutboxPublisherPort =>
        config.transport === 'eventbridge'
          ? new LazyEventBridgeOutboxPublisher(config, logger)
          : new StructuredLogOutboxPublisher(logger),
      inject: [CONFIG_TOKEN, 'OutboxPublisherPortLogger'],
    },

    // Lease-safe outbox repository — the ONLY intake outbox source.
    {
      provide: LEASE_REPO_TOKEN,
      useFactory: (repo: TalentEvidenceRepository): LeaseSafeOutboxRepository => ({
        claimOutboxBatch: (i) => repo.claimTalentIntakeOutboxBatch(i),
        markOutboxPublished: (i) =>
          repo.markTalentIntakeOutboxPublished({ event_ids: [...i.event_ids], published_at: new Date() }),
        releaseOutboxLease: (i) =>
          repo.releaseTalentIntakeOutboxLease({ event_ids: [...i.event_ids], last_error: i.last_error }),
        quarantineOutbox: (i) =>
          repo.quarantineTalentIntakeOutboxEvents({ event_ids: [...i.event_ids], reason: i.reason }),
      }),
      inject: [TalentEvidenceRepository],
    },

    // The lease-safe drain orchestration (transport-agnostic).
    { provide: 'TalentIntakeDrainServiceLogger', useFactory: () => createAramoLogger('TalentIntakeOutboxDrain') },
    {
      provide: LeaseSafeOutboxDrainService,
      useFactory: (
        leaseRepo: LeaseSafeOutboxRepository,
        port: OutboxPublisherPort,
        config: TalentIntakeEventsConfig,
        logger: AramoLogger,
      ) =>
        new LeaseSafeOutboxDrainService(
          leaseRepo,
          port,
          ENVELOPE_DEFAULTS,
          { limit: config.drainLimit, lease_seconds: config.leaseSeconds, max_attempts: config.maxAttempts },
          logger,
          config.transport,
        ),
      inject: [LEASE_REPO_TOKEN, OUTBOX_PUBLISHER_PORT, CONFIG_TOKEN, 'TalentIntakeDrainServiceLogger'],
    },

    // The Redis-independent scheduled drain worker.
    TalentIntakeOutboxDrainWorker,
    {
      provide: 'TalentIntakeOutboxDrainWorkerLogger',
      useFactory: () => createAramoLogger(TalentIntakeOutboxDrainWorker.name),
    },
  ],
  exports: [LeaseSafeOutboxDrainService],
})
export class TalentIntakePublisherModule {}
