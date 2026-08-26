import { Injectable } from '@nestjs/common';
import { RequisitionRepository } from '@aramo/requisition';
import type { RequisitionExistencePort } from '@aramo/communications';

// COMM-B5 — composition-root binding of the comms-owned requisition existence
// port (R-COMM-REQ-BOUNDARY). Communications defines the PORT and never imports
// @aramo/requisition; THIS adapter lives in apps/api, where reading the
// requisition repository is a legal composition-root import, and satisfies the
// port. `findStatusById` is tenant-safe (its WHERE pins tenant_id), returning
// null for a missing OR cross-tenant requisition — both map to "does not exist".
@Injectable()
export class RequisitionExistenceAdapter implements RequisitionExistencePort {
  constructor(private readonly requisitions: RequisitionRepository) {}

  async exists(tenantId: string, requisitionId: string): Promise<boolean> {
    const status = await this.requisitions.findStatusById({
      tenant_id: tenantId,
      id: requisitionId,
    });
    return status !== null;
  }
}
