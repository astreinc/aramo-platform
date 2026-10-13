import { Injectable } from '@nestjs/common';
import type { DossierHead, TalentDossierReadPort } from '@aramo/talent-intelligence';

import { DossierService } from '../talent-identity/dossier.service.js';

// TIP-E2E INC-2 — TalentDossierReadAdapter (apps/api composition root).
// Delegates to the existing DossierService: PRESENTS recruiter-facing outcomes
// backed by canonical talent_trust.EvidenceRecord + TrustState projection. Never
// recomputes trust, never exposes internal trust machinery, never fuses
// TalentSkillEvidence. Required DI.
@Injectable()
export class TalentDossierReadAdapter implements TalentDossierReadPort {
  constructor(private readonly dossier: DossierService) {}

  async getDossierHead(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<DossierHead> {
    const head = await this.dossier.getDossier(input.tenant_id, input.talent_record_id);
    return {
      talent_record_id: input.talent_record_id,
      ledger_established: head.ledger_established,
      verifications: head.verifications.map((v) => ({
        anchor_kind: v.anchor_kind,
        status: v.status,
      })),
      advisory_pointers: head.advisory_pointers,
    };
  }
}
