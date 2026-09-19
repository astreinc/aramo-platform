// Cold-Ingest Extraction — queue constant (one source of truth shared by
// BullModule.registerQueue, the @Processor decorator, and getQueueToken()
// callers).
//
// TI-1F P0.2 — cold-ingest is PARKED. Heuristic résumé FACT extraction is
// retired (governed LLM is the SOLE production résumé fact extractor;
// …-TI-1F-…-v1_0-LOCKED §4-D). The worker is INERT and drains nothing; the
// ingestion arrival/staging substrate (RawPayloadReference rows +
// IngestionRepository poll) is preserved untouched for a future architecture
// review. No cycle: cold-ingest-extraction imports nothing beyond the BullMQ
// runtime; lint:nx-boundaries stays green.
export const COLD_INGEST_EXTRACTION_QUEUE_NAME =
  'cold-ingest-extraction' as const;
