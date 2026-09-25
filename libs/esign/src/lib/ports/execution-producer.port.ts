// DOC-4 (R-4-3) — the executed-document producer, invoked when an envelope
// reaches COMPLETED. EsignService depends on this port OPTIONALLY: when no
// producer is bound (e.g. the DOC-3 domain tests), completion transitions with
// no executed-bytes side-effect, preserving DOC-3 behavior. apps/esign-service
// binds the concrete ExecutionService.

export const EXECUTION_PRODUCER_PORT = 'EXECUTION_PRODUCER_PORT';

export interface ExecutedProductionResult {
  envelope_document_id: string;
  source_sha256: string;
  executed_sha256: string;
  byte_size: number;
}

export interface ExecutionProducerPort {
  // Produce + persist executed bytes for every document on a COMPLETED envelope.
  produce(tenant_id: string, envelope_id: string): Promise<ExecutedProductionResult[]>;
}
