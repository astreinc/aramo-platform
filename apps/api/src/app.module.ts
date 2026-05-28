import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import {
  CommonModule,
  CrossSchemaConsistencyModule,
  RequestIdMiddleware,
} from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EngagementModule } from '@aramo/engagement';
import { IngestionModule } from '@aramo/ingestion';
import { MatchingModule } from '@aramo/matching';
import { PortalModule } from '@aramo/portal';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { SubmittalModule } from '@aramo/submittal';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    ConsentModule,
    // M5 PR-11 Gate 5-redux (Option β-1 / PL-88) — CrossSchemaConsistencyModule
    // is imported here directly (NOT via CommonModule) so its BullMQ Worker
    // is only instantiated in graphs that need it. AuthServiceModule
    // (pact provider) imports CommonModule but NOT this module, so its
    // pact-provider boot stays BullMQ-Worker-free.
    CrossSchemaConsistencyModule,
    EngagementModule,
    IngestionModule,
    MatchingModule,
    PortalModule,
    // M5 PR-11 §4.5/§4.6 — SkillsTaxonomyModule registers the
    // skill-canonicalization queue + no-op processor (Architecture v2.1
    // §9.2 / Plan v1.5 §M5 Track A item 6 binding).
    SkillsTaxonomyModule,
    SubmittalModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // PR-2 precedent: RequestIdMiddleware applies to every route. Future
    // PRs do not need to re-wire it for new endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
