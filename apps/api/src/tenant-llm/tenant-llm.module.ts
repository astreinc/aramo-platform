import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { AiDraftModule } from '@aramo/ai-draft';
import { IntegrationModule } from '@aramo/integration';

import { TenantLlmController } from './tenant-llm.controller.js';
import { TenantLlmKeyService } from './tenant-llm-key.service.js';

// TENANT-LLM-1 §P2 — per-tenant Anthropic key admin surface.
//   - IntegrationModule provides SECRETS_MANAGER_WRITER + SECRETS_MANAGER_PORT
//     (the SAME AWS Secrets Manager custody the connector path uses).
//   - AiDraftModule provides SecretCacheService so a key write invalidates the
//     per-tenant cache immediately (rotation-correctness).
@Module({
  // AuthModule (JwtAuthGuard) + AuthorizationModule (RolesGuard) + EntitlementModule
  // (EntitlementGuard) supply the ATS three-axis guard chain the controller uses.
  imports: [AuthModule, AuthorizationModule, EntitlementModule, IntegrationModule, AiDraftModule],
  controllers: [TenantLlmController],
  providers: [
    TenantLlmKeyService,
    { provide: 'TenantLlmKeyLogger', useFactory: () => createAramoLogger('TenantLlmKeyService') },
  ],
})
export class TenantLlmModule {}
