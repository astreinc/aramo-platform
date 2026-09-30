import { Injectable } from '@nestjs/common';

// Enterprise Search GS-2A — the embedding-processing activation gate. DARK BY DEFAULT, mirroring the
// CI_PROCESSING_ENABLED pattern: EMBEDDING_PROCESSING_ENABLED must be exactly "true" to enable the
// background embedding worker. Absent / "false" / anything else → DISABLED (no work claimed, no model
// invoked). Server-side only — NEVER request/job-derived. This is the safety interlock that keeps the
// worker inert until the PROD PostgreSQL runtime is pgvector-capable and the GS-2A migration applied.
const EMBEDDING_PROCESSING_ENABLED_ENV = 'EMBEDDING_PROCESSING_ENABLED';

@Injectable()
export class EmbeddingProcessingConfig {
  /** Reads the environment on each call so a flag flip needs only a restart. */
  isEnabled(): boolean {
    return process.env[EMBEDDING_PROCESSING_ENABLED_ENV] === 'true';
  }
}
