import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { SubmittalModule } from '@aramo/submittal';

import { TalentJourneyAuditController } from './talent-journey-audit.controller.js';
import { TalentJourneyAuditService } from './talent-journey-audit.service.js';

// INC-1e (TIP-E2E) — composition root for the correlated journey-audit read. Imports:
//   - AuthModule      → JwtAuthGuard / AuthContext (+ RolesGuard metadata)
//   - SubmittalModule → SubmittalRepository (visibility-scoped findByIdForActor) +
//                       TalentSubmittalEventRepository (immutable transition timeline)
// Read-only: no new repository, no new event authority, no migration.
@Module({
  imports: [AuthModule, SubmittalModule],
  controllers: [TalentJourneyAuditController],
  providers: [TalentJourneyAuditService],
})
export class TalentJourneyAuditModule {}
