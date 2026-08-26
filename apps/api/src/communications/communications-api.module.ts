import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommunicationsModule, VoiceProviderRegistry, ZoomPhoneAdapter } from '@aramo/communications';
import { EntitlementModule } from '@aramo/entitlement';
import { IntegrationModule } from '@aramo/integration';

import { CommunicationsController } from './communications.controller.js';
import { CommunicationsApiService } from './communications-api.service.js';

// COMM-B2/B3 (Aramo-COMM-V1) — apps/api composition root for the /v1/communications
// surface. Imports the domain CommunicationsModule (repository + empty
// VoiceProviderRegistry + per-module PrismaService), the guard modules for the
// three-axis authorization, and IntegrationModule (COMM-B3) so the service can
// resolve the tenant's provider connection (composition-root read into
// @aramo/integration — NO libs/communications → integration nx edge).
//
// COMM-B3 registers the real ZoomPhoneAdapter into the (module-scoped)
// VoiceProviderRegistry under the locked key `zoom_phone` (replacing the B2 fake).
// The adapter's static capability descriptor is CI-safe; live Zoom calls stay
// behind the VoiceProvider port (B5/B6/B8). Capability resolution binds by the
// tenant connection's provider_key — there is NO default/fake fallback.
const ZOOM_VOICE_PROVIDER_REGISTRAR = Symbol('ZOOM_VOICE_PROVIDER_REGISTRAR');

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    CommunicationsModule,
    IntegrationModule,
  ],
  controllers: [CommunicationsController],
  providers: [
    CommunicationsApiService,
    {
      provide: ZOOM_VOICE_PROVIDER_REGISTRAR,
      useFactory: (registry: VoiceProviderRegistry): true => {
        const adapter = new ZoomPhoneAdapter();
        if (!registry.has(adapter.providerKey())) {
          registry.register(adapter);
        }
        return true;
      },
      inject: [VoiceProviderRegistry],
    },
  ],
})
export class CommunicationsApiModule {}
