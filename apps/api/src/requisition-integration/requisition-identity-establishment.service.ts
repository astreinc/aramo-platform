import { Injectable, Logger } from '@nestjs/common';
import { RequisitionRepository } from '@aramo/requisition';
import { ExternalRequisitionIdentityRepository } from '@aramo/integration';

// CB-D2-A1 (ADR-0030, R-IDENTITY LOCK) — the idempotent POST-ESTABLISHMENT
// handoff that records the connection-scoped external→internal requisition
// identity after a connector import establishes a Requisition (T8-P2).
//
// Grounding (build-recon): atomic-with-create is not reachable — the import lib
// (@aramo/import) does not know the connection_id, and the delivery orchestrator
// does not know the created requisition_id. The deterministic chain
// `ConnectorDelivery.import_batch_id → Requisition.import_batch_id` DOES exist, so
// this app-level handoff resolves (external_req_id → requisition_id) by the batch
// and records identity idempotently. It is invoked on the connector execution
// success path (PROCESSED / ALREADY_PROCESSED — both carry import_batch_id), and a
// write failure is SURFACED (thrown) so the job replays (never silent) — the
// establishment and the identity record are both idempotent.
//
// HARD PROHIBITION: this reads requisition rows (id, external_req_id) but NEVER
// mutates a requisition; the identity row lives in the integration schema.
@Injectable()
export class RequisitionIdentityEstablishmentService {
  private readonly logger = new Logger(RequisitionIdentityEstablishmentService.name);

  constructor(
    private readonly requisitions: RequisitionRepository,
    private readonly identities: ExternalRequisitionIdentityRepository,
  ) {}

  /**
   * Record the connection-scoped identity for every provenanced requisition the
   * given import batch established. Idempotent: a redelivery/replay resolves to
   * the existing identity rows without repointing them. Rows with no
   * external_req_id (non-provenanced) are skipped.
   */
  async establishForImportBatch(args: {
    tenant_id: string;
    connection_id: string;
    import_batch_id: string;
  }): Promise<number> {
    const rows = await this.requisitions.findExternalIdentitiesByImportBatch({
      tenant_id: args.tenant_id,
      import_batch_id: args.import_batch_id,
    });
    let recorded = 0;
    for (const row of rows) {
      if (row.external_req_id === null) continue;
      await this.identities.record({
        tenant_id: args.tenant_id,
        connection_id: args.connection_id,
        external_req_id: row.external_req_id,
        requisition_id: row.requisition_id,
      });
      recorded += 1;
    }
    this.logger.debug(
      `established ${recorded} external requisition identity row(s) for batch ${args.import_batch_id}`,
    );
    return recorded;
  }
}
