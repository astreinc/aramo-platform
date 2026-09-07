import type { RequisitionAnalysisSource } from '../dto/requisition-analysis-context.js';

// CI-B2 — the Requisition analysis-context READER port.
//
// The snapshot service never trusts a client-supplied payload; it asks a
// reader to resolve the authorized, allowlisted recruiting context for a
// (tenant, requisition) pair, then the server constructs the snapshot
// from that source (directive §10 creation semantics). Abstracting the
// read behind a port keeps the snapshot substrate decoupled from the
// Requisition + GoldenProfile read mechanics and lets the service be
// unit-tested with a fake reader.
//
// Contract:
//   - load(tenant, requisition) returns the allowlisted source, or
//     `null` when the requisition does not exist IN THAT TENANT
//     (conceal — the tenant boundary is enforced inside the reader by a
//     tenant-scoped WHERE, mirroring the requisition repository's
//     null-conceal convention).
//   - The reader MUST NOT populate any gated compensation / financial
//     field on the returned source (there is no such field on
//     RequisitionAnalysisSource — the type itself forbids it).

export const REQUISITION_ANALYSIS_CONTEXT_READER =
  'REQUISITION_ANALYSIS_CONTEXT_READER';

export interface RequisitionAnalysisContextReader {
  load(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<RequisitionAnalysisSource | null>;
}
