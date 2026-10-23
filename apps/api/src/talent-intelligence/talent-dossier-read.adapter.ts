import { Injectable } from '@nestjs/common';
import type { DossierHead, TalentDossierReadPort } from '@aramo/talent-intelligence';

import { DossierService } from '../talent-identity/dossier.service.js';

// TIP-E2E INC-2 → ATI-SEP-1 T10 WP3b — TalentDossierReadAdapter (apps/api
// composition root). Delegates to DossierService, which now PRESENTS Talent
// Intelligence's tenant view of the record (fail-soft: TI not configured / not
// entitled / down → ledger_established:false, no verifications). Verification
// outcomes are TI's contact facts (anchor_kind EMAIL | PHONE, status VERIFIED |
// DECLARED | DOCUMENT_SUPPORTED). Duplicate-advisory pointers are no longer a
// trust read: the ATS-local advisories (WP2) feed Talent 360 directly, so this
// port reports none. Required DI.
@Injectable()
export class TalentDossierReadAdapter implements TalentDossierReadPort {
  constructor(private readonly dossier: DossierService) {}

  async getDossierHead(input: { tenant_id: string; talent_record_id: string }): Promise<DossierHead> {
    const head = await this.dossier.getDossier(input.tenant_id, input.talent_record_id);
    return {
      talent_record_id: input.talent_record_id,
      ledger_established: head.ledger_established,
      verifications: head.verifications.map((v) => ({ anchor_kind: v.anchor_kind, status: v.status })),
      advisory_pointers: [],
    };
  }
}
