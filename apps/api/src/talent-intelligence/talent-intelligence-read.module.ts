import { Global, Module } from '@nestjs/common';
import { ConsentModule } from '@aramo/consent';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';
import {
  AUTHORIZED_TALENT_RETRIEVAL_READ_PORT,
  REQUISITION_CONTEXT_READ_PORT,
  TALENT_DOSSIER_READ_PORT,
} from '@aramo/talent-intelligence';

import { TalentIdentityModule } from '../talent-identity/talent-identity.module.js';

import { AuthorizedTalentRetrievalReadAdapter } from './authorized-talent-retrieval-read.adapter.js';
import { RequisitionContextReadAdapter } from './requisition-context-read.adapter.js';
import { TalentDossierReadAdapter } from './talent-dossier-read.adapter.js';

// TIP-E2E INC-2 — the apps/api composition root for the Talent Intelligence read
// seam. Binds the three domain-owned ports to their concrete adapters by REQUIRED
// DI (useExisting on @Injectable adapters). @Global so the consuming composition
// (Talent-360) can inject the tokens. A missing adapter dependency fails at
// bootstrap — no @Optional, no silent fallback (ARAMO-TIP-E2E-INC-2-v1.0-LOCKED §7).
@Global()
@Module({
  imports: [RequisitionModule, TalentRecordModule, ConsentModule, TalentIdentityModule],
  providers: [
    RequisitionContextReadAdapter,
    AuthorizedTalentRetrievalReadAdapter,
    TalentDossierReadAdapter,
    { provide: REQUISITION_CONTEXT_READ_PORT, useExisting: RequisitionContextReadAdapter },
    {
      provide: AUTHORIZED_TALENT_RETRIEVAL_READ_PORT,
      useExisting: AuthorizedTalentRetrievalReadAdapter,
    },
    { provide: TALENT_DOSSIER_READ_PORT, useExisting: TalentDossierReadAdapter },
  ],
  exports: [
    REQUISITION_CONTEXT_READ_PORT,
    AUTHORIZED_TALENT_RETRIEVAL_READ_PORT,
    TALENT_DOSSIER_READ_PORT,
  ],
})
export class TalentIntelligenceReadModule {}
