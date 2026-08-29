import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { createAramoLogger } from '@aramo/common';
import { EntitlementModule } from '@aramo/entitlement';
import {
  ClientSelectionModule,
  ClientSelectionPrismaService,
} from '@aramo/client-selection';

import { ClientSelectionOrchestrationController } from './client-selection-orchestration.controller.js';
import { ClientSelectionCreateFromSubmittalService } from './client-selection-create.service.js';

// Lane 2 / L2-F (F1) — the ClientSelectionProcess create-from-submittal composition
// root (apps/api). Hosts the CREATE route + orchestration service that the owner lib
// (@aramo/client-selection) deliberately does not: reads the foreign Submittal +
// Pipeline aggregates (raw parameterized SQL) to derive the owner's denormalized keys,
// then delegates the atomic write to the owner's ClientSelectionProcessRepository.
//   - AuthModule / AuthorizationModule / EntitlementModule — the ATS guard chain
//     (JwtAuthGuard, RolesGuard, EntitlementGuard) the controller declares.
//   - ClientSelectionModule — exports ClientSelectionProcessRepository (the write) +
//     ClientSelectionPrismaService (bound as 'ClientSelectionCreateDb' for the raw
//     cross-schema reads; the same singleton the repository uses).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, ClientSelectionModule],
  controllers: [ClientSelectionOrchestrationController],
  providers: [
    ClientSelectionCreateFromSubmittalService,
    {
      provide: 'ClientSelectionCreateDb',
      useExisting: ClientSelectionPrismaService,
    },
    {
      provide: 'ClientSelectionCreateLogger',
      useFactory: () =>
        createAramoLogger(ClientSelectionCreateFromSubmittalService.name),
    },
  ],
})
export class ClientSelectionOrchestrationModule {}
