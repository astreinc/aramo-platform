import { Injectable } from '@nestjs/common';
import { ImportService, type ImportBatchView, type RunRequisitionImportRequestDto } from '@aramo/import';

import type {
  HandoffFailure,
  RequisitionImportHandoffPort,
} from './requisition-import-handoff.port.js';

// T8-CONNECTOR-A — production handoff adapter (directive §11, LOCKED direct
// service reuse). A THIN 1:1 delegation to the exact ImportService methods the
// public POST /v1/requisition-imports controller uses. NOT a repository bypass,
// NOT a self-HTTP call — CREATE-only canonical semantics, tenant binding,
// external-identity enforcement, ImportBatch/ImportFailure, audit/lifecycle and
// error behavior are all preserved because it is literally the same service call.
@Injectable()
export class ImportServiceHandoff implements RequisitionImportHandoffPort {
  constructor(private readonly importService: ImportService) {}

  run(args: {
    tenant_id: string;
    imported_by_id: string;
    input: RunRequisitionImportRequestDto;
    scopes: readonly string[];
    requestId: string;
  }): Promise<ImportBatchView> {
    return this.importService.runCanonicalRequisitionImport({
      tenant_id: args.tenant_id,
      imported_by_id: args.imported_by_id,
      input: args.input,
      scopes: args.scopes,
      requestId: args.requestId,
    });
  }

  async listFailures(args: {
    tenant_id: string;
    import_batch_id: string;
    requestId: string;
  }): Promise<readonly HandoffFailure[]> {
    const failures = await this.importService.listFailures({
      tenant_id: args.tenant_id,
      import_batch_id: args.import_batch_id,
      requestId: args.requestId,
    });
    return failures.map((f) => ({
      row_number: f.row_number,
      failure_reason: f.failure_reason,
    }));
  }
}
