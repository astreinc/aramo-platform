import { AiDraftModule } from '@aramo/ai-draft';
import { ConsentModule } from '@aramo/consent';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TechnicalScreeningModule } from '@aramo/technical-screening';

import { ScreeningAiConsentAdapter } from './screening-ai-consent.adapter.js';
import { ScreeningTrustPublisherAdapter } from './screening-trust-publisher.adapter.js';

// TIP-E2E INC-3 — the ONE technical-screening domain registration. Shared by the
// screening HTTP surface and (INC-3 A1-5) the CI screening-profile adapters, so
// both resolve the SAME module instance (one repository, one publisher) without
// a module cycle. The Talent Trust publisher adapter is REQUIRED (a missing
// adapter fails at bootstrap); A1-3 binds the existing ai_processing consent
// operation, fail closed.
export const ScreeningDomain = TechnicalScreeningModule.register({
  publisher: ScreeningTrustPublisherAdapter,
  aiConsent: ScreeningAiConsentAdapter,
  imports: [TalentTrustModule, AiDraftModule, ConsentModule],
});
