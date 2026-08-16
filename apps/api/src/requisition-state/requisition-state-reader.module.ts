import { Global, Module } from '@nestjs/common';
import { RequisitionModule } from '@aramo/requisition';
import { REQUISITION_STATE_READER } from '@aramo/examination';

import { RequisitionRepositoryStateReaderAdapter } from './requisition-state-reader.adapter.js';

// T1-a (Track 1 Directive §2, L1) — composition-root binding for the
// RequisitionStateReader port. @Global because the port's consumers
// (ExaminationRepository + MatchListController) are declared inside
// ExaminationModule (scope:cip), which is transitively imported by
// Matching/Submittal/Evidence/Selection modules; a @Global export makes the
// single ATS-backed adapter resolvable in every injector without any of those
// CIP libs importing scope:ats. RequisitionModule is imported so the adapter can
// depend on RequisitionRepository.
@Global()
@Module({
  imports: [RequisitionModule],
  providers: [
    RequisitionRepositoryStateReaderAdapter,
    {
      provide: REQUISITION_STATE_READER,
      useClass: RequisitionRepositoryStateReaderAdapter,
    },
  ],
  exports: [REQUISITION_STATE_READER],
})
export class RequisitionStateReaderModule {}
