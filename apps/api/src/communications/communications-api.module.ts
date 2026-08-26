import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommunicationsModule, FakeVoiceProvider, VoiceProviderRegistry } from '@aramo/communications';
import { EntitlementModule } from '@aramo/entitlement';

import { CommunicationsController } from './communications.controller.js';
import { CommunicationsApiService } from './communications-api.service.js';

// COMM-B2 (Aramo-COMM-V1) — apps/api composition root for the /v1/communications
// read skeleton. Imports the domain CommunicationsModule (repository + empty
// VoiceProviderRegistry + per-module PrismaService) and the guard modules for the
// three-axis authorization. The consent gate is NOT wired here yet — it enters
// with the B5 call orchestration (apps/api → consent), preserving the rule that
// libs/communications never imports @aramo/consent.
//
// FakeVoiceProvider is registered into the (module-scoped) VoiceProviderRegistry
// as the B2 test/composition provider (directive: registered ONLY as the B2
// composition provider). COMM-B3 registers the real ZoomPhoneAdapter and adds
// per-tenant connection resolution.
const FAKE_VOICE_PROVIDER_REGISTRAR = Symbol('FAKE_VOICE_PROVIDER_REGISTRAR');

@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, CommunicationsModule],
  controllers: [CommunicationsController],
  providers: [
    CommunicationsApiService,
    {
      provide: FAKE_VOICE_PROVIDER_REGISTRAR,
      useFactory: (registry: VoiceProviderRegistry): true => {
        if (!registry.has(new FakeVoiceProvider().providerKey())) {
          registry.register(new FakeVoiceProvider());
        }
        return true;
      },
      inject: [VoiceProviderRegistry],
    },
  ],
})
export class CommunicationsApiModule {}
