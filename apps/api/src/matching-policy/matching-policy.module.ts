import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { MATCHING_POLICY_SOURCE } from '@aramo/matching';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';

import { MatchingPolicyController } from './matching-policy.controller.js';
import { StoreMatchingPolicySource } from './matching-policy.source.js';

// ATI-SEP-1 A2 A-c (P1) — the platform-owned MatchingPolicy at the composition root.
//   - The platform HTTP surface (MatchingPolicyController, /platform/matching-policy*,
//     platform:matching_policy:{read,write}, platform tier only). Tenants have NO route.
//   - The MATCHING_POLICY_SOURCE binding, @Global so MatchingService (inside
//     libs/matching's MatchingModule, which never imports the store) resolves it —
//     the SubmittedHistoryModule port pattern. apps/api already depends on
//     @aramo/matching, @aramo/skills-taxonomy, @aramo/auth and @aramo/authorization:
//     zero new nx edges.
@Global()
@Module({
  imports: [AuthModule, AuthorizationModule, SkillsTaxonomyModule],
  controllers: [MatchingPolicyController],
  providers: [
    StoreMatchingPolicySource,
    { provide: MATCHING_POLICY_SOURCE, useExisting: StoreMatchingPolicySource },
  ],
  exports: [MATCHING_POLICY_SOURCE],
})
export class MatchingPolicyModule {}
