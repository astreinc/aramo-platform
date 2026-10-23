// ADR-0036 Decision 3/4 — the TI HTTP surface. The ingestion DTOs live in
// ./ingest.ts (T2 closed admission schema); the read DTO stays a placeholder
// until the read API increment.

export const INTELLIGENCE_SERVICE_NAME = 'talent-intelligence-service' as const;

export interface IntelligenceHealthResponse {
  service: typeof INTELLIGENCE_SERVICE_NAME;
  status: 'ok' | 'degraded';
  database: 'ok' | 'unavailable';
}

/** GET /v1/references/{tenant}/{talent}/profile — placeholder; the read increment fills it. */
export interface IntelligenceProfileReadResponse {
  intelligence_subject_id: string;
  profile: Record<string, never>;
}
