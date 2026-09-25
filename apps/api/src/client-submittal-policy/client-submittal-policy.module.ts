import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CLIENT_SUBMITTAL_POLICY_GATEWAY, ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';
import { PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import {
  CLIENT_SUBMITTAL_POLICY_DB,
  ClientSubmittalPolicyGatewayAdapter,
} from './client-submittal-policy-gateway.adapter.js';
import { ClientSubmittalPolicyController } from './client-submittal-policy.controller.js';

// CSP PR-2 — the composition root for the Client Submittal Policy admin surface.
// Binds the raw-SQL StoredPolicyVersion gateway (over the policy-store connection)
// and the pure ClientSubmittalPolicyService. DARK: exposes authoring + effective
// read only; the submit command does NOT consume this yet (PR-3). CompanyClientCheck
// is provided @Global (reused ownership seam).
@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [ClientSubmittalPolicyController],
  providers: [
    PolicyStorePrismaService,
    { provide: CLIENT_SUBMITTAL_POLICY_DB, useExisting: PolicyStorePrismaService },
    ClientSubmittalPolicyGatewayAdapter,
    { provide: CLIENT_SUBMITTAL_POLICY_GATEWAY, useExisting: ClientSubmittalPolicyGatewayAdapter },
    ClientSubmittalPolicyService,
  ],
  exports: [ClientSubmittalPolicyService],
})
export class ClientSubmittalPolicyModule {}
