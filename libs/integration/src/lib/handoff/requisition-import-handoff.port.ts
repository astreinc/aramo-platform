import type {
  ImportBatchView,
  RunRequisitionImportRequestDto,
} from '@aramo/import';

// T8-CONNECTOR-A — the canonical T8-P2 handoff boundary (directive §11, LOCKED
// direct-service-reuse ruling).
//
// This port is a THIN pass-through to the exact ImportService method the public
// POST /v1/requisition-imports controller calls — `runCanonicalRequisitionImport`
// — plus its tenant-safe failure reader. It is NOT a repository bypass and NOT a
// self-HTTP call. The port exists only so the orchestrator can be unit-tested
// with a fake; the production adapter delegates 1:1 to ImportService.

/** The identity-conflict failure token P2 records for an existing external id. */
export const EXTERNAL_IDENTITY_CONFLICT_REASON =
  'REQUISITION_EXTERNAL_IDENTITY_CONFLICT' as const;

export interface HandoffFailure {
  readonly row_number: number;
  readonly failure_reason: string;
}

export interface RequisitionImportHandoffPort {
  /** Direct reuse of ImportService.runCanonicalRequisitionImport — CREATE-only. */
  run(args: {
    tenant_id: string;
    imported_by_id: string;
    input: RunRequisitionImportRequestDto;
    scopes: readonly string[];
    requestId: string;
  }): Promise<ImportBatchView>;

  /** Tenant-safe read of the batch's per-record failure reasons (for classification). */
  listFailures(args: {
    tenant_id: string;
    import_batch_id: string;
    requestId: string;
  }): Promise<readonly HandoffFailure[]>;
}

export const REQUISITION_IMPORT_HANDOFF = Symbol('REQUISITION_IMPORT_HANDOFF');
