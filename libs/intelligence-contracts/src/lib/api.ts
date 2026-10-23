import type { SourceSystemId } from './events.js';

// ADR-0036 Decision 3/4 — the TI HTTP surface. T0 ships the health shape; the
// ingestion and read DTOs are PLACEHOLDERS that T2 replaces with the closed
// admission schema (Class A/B fields, unknown keys rejected).

export const INTELLIGENCE_SERVICE_NAME = 'talent-intelligence-service' as const;

export interface IntelligenceHealthResponse {
  service: typeof INTELLIGENCE_SERVICE_NAME;
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
}

/** POST /v1/ingest/talent — placeholder; T2 defines the admitted fields. */
export interface TalentIngestionRequest {
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
  source_event_id: string;
  profile: Record<string, never>;
}

export interface TalentIngestionResponse {
  intelligence_subject_id: string;
  outcome: 'CREATED' | 'LINKED' | 'DUPLICATE_EVENT';
}

/** GET /v1/references/{tenant}/{talent}/profile — placeholder; T2 fills it. */
export interface IntelligenceProfileReadResponse {
  intelligence_subject_id: string;
  profile: Record<string, never>;
}
