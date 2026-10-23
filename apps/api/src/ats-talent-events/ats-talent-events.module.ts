import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger, type AramoLogger } from '@aramo/common';
import { CanonicalReconcileModule } from '@aramo/canonical-reconcile';
import type { EnvelopeDefaults, LeaseSafeOutboxRepository } from '@aramo/events';
import { LeaseSafeOutboxDrainService } from '@aramo/outbox-publisher';
import {
  TALENT_EVENT_SOURCE,
  TALENT_EVENT_SUBJECT_TYPE,
  TALENT_EVENT_VERSION,
  TalentEventOutboxRepository,
  TalentRecordModule,
} from '@aramo/talent-record';
import { IntelligenceIntegrationModule, IntelligencePublisherHandler } from '@aramo/intelligence-integration';
import { SourcedTalentModule } from '@aramo/sourced-talent';

import { DuplicateDetectionService } from '../talent-identity/duplicate-detection.service.js';

import { AtsTalentEventDispatcher } from './ats-talent-event-dispatcher.js';
import { ATS_TALENT_EVENT_HANDLERS, type AtsTalentEventHandler } from './ats-talent-event-handler.js';
import { ATS_TALENT_EVENTS_DRAIN, AtsTalentEventsDrainWorker } from './ats-talent-events-drain.worker.js';
import { CanonicalReconcileTalentEventHandler } from './reconcile-signal.handlers.js';
import { DuplicateDetectionTalentEventHandler } from './duplicate-detection.handler.js';

// ATI-SEP-1 A3 (ADR-0036 §3) — the ATS talent outbox drain + in-process
// dispatcher. Imported by the talent-intake-worker context (where the drain is
// ON by default) and by AppModule (where it is OFF unless
// ATS_TALENT_EVENTS_DRAIN_ENABLED=1). Nothing here is reachable from an ATS
// request path: the only producer coupling is the outbox row the ATS write
// commits.

const LEASE_REPO_TOKEN = 'ATS_TALENT_EVENTS_LEASE_REPOSITORY';

// Every row is written with explicit envelope columns; these are only the
// structural fallbacks buildEventEnvelope requires.
const ENVELOPE_DEFAULTS: EnvelopeDefaults = {
  source: TALENT_EVENT_SOURCE,
  event_version: TALENT_EVENT_VERSION,
  subjectTypeFor: () => TALENT_EVENT_SUBJECT_TYPE,
  subjectIdFor: (row) =>
    String((row.event_payload as { talent_record_id?: string } | null)?.talent_record_id ?? row.id),
};

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

@Module({
  imports: [
    CommonModule,
    TalentRecordModule,
    CanonicalReconcileModule,
    // ATI-SEP-1 T10 WP2 — the duplicate detector's sourced-arrival leg.
    SourcedTalentModule,
    // ATI-SEP-1 T8 — the Intelligence publisher (+ the worker's inbound sync /
    // entitlement sync loops, active only in the drain-enabled worker process).
    IntelligenceIntegrationModule,
  ],
  providers: [
    CanonicalReconcileTalentEventHandler,
    // ATI-SEP-1 T10 WP2 — ATS-local within-tenant duplicate advisories.
    DuplicateDetectionService,
    DuplicateDetectionTalentEventHandler,
    // EXTENSION POINT — ATI-SEP-1 T8 appended the Intelligence publisher
    // (provided by IntelligenceIntegrationModule). Order: the ATS-internal
    // reconciles first, then the TI publisher.
    {
      provide: ATS_TALENT_EVENT_HANDLERS,
      useFactory: (...handlers: AtsTalentEventHandler[]): readonly AtsTalentEventHandler[] => handlers,
      inject: [
        CanonicalReconcileTalentEventHandler,
        // ATI-SEP-1 T10 WP2 — ATS-local duplicate advisories (ATS data only).
        DuplicateDetectionTalentEventHandler,
        // ATI-SEP-1 T10 WP1 — the legacy trust feed + the talent-reconcile
        // signal handlers were removed (write-side legacy feeds off).
        // ATI-SEP-1 T8 — ATS → TI (entitlement-gated; no-op when TI is unconfigured).
        IntelligencePublisherHandler,
      ],
    },
    { provide: 'AtsTalentEventDispatcherLogger', useFactory: () => createAramoLogger(AtsTalentEventDispatcher.name) },
    AtsTalentEventDispatcher,
    {
      provide: LEASE_REPO_TOKEN,
      useFactory: (repo: TalentEventOutboxRepository): LeaseSafeOutboxRepository => ({
        claimOutboxBatch: (i) => repo.claimOutboxBatch(i),
        markOutboxPublished: (i) => repo.markOutboxPublished(i),
        releaseOutboxLease: (i) => repo.releaseOutboxLease(i),
        quarantineOutbox: (i) => repo.quarantineOutbox(i),
      }),
      inject: [TalentEventOutboxRepository],
    },
    { provide: 'AtsTalentEventsDrainLogger', useFactory: () => createAramoLogger('AtsTalentEventsDrain') },
    {
      provide: ATS_TALENT_EVENTS_DRAIN,
      useFactory: (
        leaseRepo: LeaseSafeOutboxRepository,
        dispatcher: AtsTalentEventDispatcher,
        logger: AramoLogger,
      ) =>
        new LeaseSafeOutboxDrainService(
          leaseRepo,
          dispatcher,
          ENVELOPE_DEFAULTS,
          {
            limit: envInt('ATS_TALENT_EVENTS_DRAIN_LIMIT', 25),
            lease_seconds: envInt('ATS_TALENT_EVENTS_LEASE_SECONDS', 120),
            max_attempts: envInt('ATS_TALENT_EVENTS_MAX_ATTEMPTS', 10),
          },
          logger,
          'in-process-dispatch',
        ),
      inject: [LEASE_REPO_TOKEN, AtsTalentEventDispatcher, 'AtsTalentEventsDrainLogger'],
    },
    { provide: 'AtsTalentEventsDrainWorkerLogger', useFactory: () => createAramoLogger(AtsTalentEventsDrainWorker.name) },
    AtsTalentEventsDrainWorker,
  ],
  exports: [AtsTalentEventsDrainWorker, ATS_TALENT_EVENTS_DRAIN, AtsTalentEventDispatcher],
})
export class AtsTalentEventsModule {}
