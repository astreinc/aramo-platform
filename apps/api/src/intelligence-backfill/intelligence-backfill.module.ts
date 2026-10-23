import { Module } from '@nestjs/common';
import { IntelligenceIntegrationModule } from '@aramo/intelligence-integration';

// ATI-SEP-1 — the process-local root of the `intelligence-backfill` CLI: the ATS
// side of the TI integration only (HTTP client + allowlisted ATS reads). No HTTP
// server, no outbox drain, no background loops (the command pins
// ATS_TALENT_EVENTS_DRAIN_ENABLED=0 before bootstrap).
@Module({ imports: [IntelligenceIntegrationModule] })
export class IntelligenceBackfillModule {}
