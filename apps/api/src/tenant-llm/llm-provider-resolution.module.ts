import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '@aramo/settings';
import { ACTIVE_PROVIDER_RESOLVER } from '@aramo/ai-draft';

import { SettingsActiveProviderResolver } from './settings-active-provider.resolver.js';

// TENANT-LLM-2 — binds ai-draft's ActiveProviderResolver port to the
// settings-backed implementation and exposes it @Global so the ai-draft
// dispatchers (which @Optional-inject ACTIVE_PROVIDER_RESOLVER inside the
// AiDraftModule injector) resolve it wherever AiDraftModule is consumed —
// without threading it through every AiDraftModule import site. Absent this
// module (isolated ai-draft tests) the dispatchers default to 'anthropic'.
@Global()
@Module({
  imports: [SettingsModule],
  providers: [
    { provide: ACTIVE_PROVIDER_RESOLVER, useClass: SettingsActiveProviderResolver },
  ],
  exports: [ACTIVE_PROVIDER_RESOLVER],
})
export class LlmProviderResolutionModule {}
