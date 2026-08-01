import { Injectable } from '@nestjs/common';
import { RequisitionRepository } from '@aramo/requisition';
import type { RequisitionStateReader } from '@aramo/examination';

// T1-a (Track 1 Directive §2, L1) — the apps/api adapter that satisfies
// libs/examination's RequisitionStateReader port, backed by the ATS
// RequisitionRepository. This is the ONLY seam that bridges the CIP Live List /
// match-list to the ATS requisition lifecycle; examination imports nothing from
// scope:ats, so the Pipeline⊥ATS wall holds by construction (the auth-decoupling
// adapter precedent: apps/auth-service IdentityIndexEligibilityAdapter).
//
// `isActive` folds the two facts the retired job_domain mirror carried
// (existence-in-tenant + state) into a single tenant-scoped read:
// findStatusById returns null for a missing or cross-tenant requisition and the
// stored RequisitionStatus otherwise. Only 'active' is live; every other status
// (closed / on_hold / full / canceled / lead) is not — which is exactly the
// defect the mirror hid.
@Injectable()
export class RequisitionRepositoryStateReaderAdapter implements RequisitionStateReader {
  constructor(private readonly requisitionRepository: RequisitionRepository) {}

  async isActive(tenant_id: string, requisition_id: string): Promise<boolean> {
    const status = await this.requisitionRepository.findStatusById({
      tenant_id,
      id: requisition_id,
    });
    return status === 'active';
  }
}
