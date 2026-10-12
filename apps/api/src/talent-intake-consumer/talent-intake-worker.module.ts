import { Module } from '@nestjs/common';

import { TalentIntakePublisherModule } from './talent-intake-publisher.module.js';

// ADR-0033 / single-box — the dedicated Talent Intake WORKER context. It boots
// ONLY the lease-safe outbox drain and its publisher/handler/extraction closure
// (via TalentIntakePublisherModule) — NOT the full API/HTTP graph and NONE of the
// other API background workers — so a single-box worker container stays lean on
// the 4 GB box. Started by talent-intake-worker.main.ts as a NestFactory
// application context (no HTTP listener). With TALENT_INTAKE_TRANSPORT=singlebox
// the drain delivers each canonical outbox envelope directly to the in-process
// TalentIntakeMessageHandler; with eventbridge it publishes to the bus — same
// worker, same real DI graph, transport chosen by config.
@Module({ imports: [TalentIntakePublisherModule] })
export class TalentIntakeWorkerModule {}
