import { Module } from '@nestjs/common';

import { RedisConnectionConfig } from './redis/redis-connection.config.js';
import { RequestIdMiddleware } from './middleware/request-id.middleware.js';

// M5 PR-11 Gate 5-redux (Option β-1; PL-88 ratification):
//
// CommonModule is BullMQ-Worker-FREE. RedisConnectionConfig is provided
// here as a shared config service (config-only, no Worker instantiation)
// so consumers (libs/consent, libs/skills-taxonomy, the dedicated
// CrossSchemaConsistencyModule, future job modules) can inject it.
//
// PL-88 (RATIFIED at Gate 5-redux): BullMQ processors live in dedicated
// job-modules within their owning lib, NEVER in CommonModule or other
// broadly-imported universal-utility modules. Rationale: BullExplorer
// auto-registers Workers at onModuleInit; a processor in CommonModule
// leaks Worker instantiation into every consumer graph including
// non-job contexts (apps/auth-service pact provider, narrow app modules)
// lacking REDIS_URL — those graphs fail with "Worker requires a
// connection" at module init. Cross-schema-consistency was extracted to
// libs/common/src/lib/cross-schema-consistency/cross-schema-consistency.module.ts
// at Gate 5-redux.
@Module({
  providers: [RedisConnectionConfig, RequestIdMiddleware],
  exports: [RedisConnectionConfig, RequestIdMiddleware],
})
export class CommonModule {}
