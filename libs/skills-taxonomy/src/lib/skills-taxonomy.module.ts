import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { SkillRepository } from './skill.repository.js';
import { SkillAliasRepository } from './skill-alias.repository.js';
import { SkillVersionRepository } from './skill-version.repository.js';
import { SkillRelationshipRepository } from './skill-relationship.repository.js';
import { SkillRegistryService } from './skill-registry.service.js';
import { SkillCanonicalizationService } from './skill-canonicalization.service.js';
import { SkillCanonicalizationProcessor } from './skill-canonicalization.processor.js';
import { SKILL_CANONICALIZATION_QUEUE_NAME } from './skill-canonicalization.queue.constants.js';

// M5 PR-11 §4.5 — SkillsTaxonomyModule gains skill-canonicalization
// processor + queue registration (Architecture v2.1 §9.2 / Plan v1.5
// §M5 Track A item 6 binding; doc/01 §13 anchor).
//
// SKILL-TAX-1A adds the canonical Skill registry surface — PrismaService +
// SkillRepository + SkillRegistryService (internal only; no controller / HTTP
// / scope in 1A). The skill-canonicalization BullMQ processor remains a NO-OP
// (ADR-0018 Decision 8): its resolution logic is deferred to SKILL-TAX-1C and
// is deliberately NOT wired to the new registry yet.
//
// BullModule.forRootAsync mirrors libs/matching pattern (ADR-0018
// Decision 1). Mirrors libs/consent's PR-11 wiring (consent.module.ts
// PR-11 §4.2/§4.3) for cross-lib parity. At apps/api level, multiple
// forRootAsync registrations from matching + consent + skills-taxonomy
// resolve to the same RedisConnectionConfig source (provided in libs/common
// + duplicated via extraProviders here following the M3-era libs/matching
// precedent).
@Module({
  imports: [
    CommonModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return {
            ...baseOpts,
            connection: { ...cfg.connection, lazyConnect: true },
          };
        } catch (err) {
          if (err instanceof Error && err.message === 'REDIS_URL is not configured') {
            return {
              ...baseOpts,
              connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
            };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: SKILL_CANONICALIZATION_QUEUE_NAME }),
  ],
  providers: [
    PrismaService,
    SkillRepository,
    SkillAliasRepository,
    SkillVersionRepository,
    SkillRelationshipRepository,
    SkillRegistryService,
    SkillCanonicalizationService,
    SkillCanonicalizationProcessor,
    {
      provide: 'SkillCanonicalizationProcessorLogger',
      useFactory: () => createAramoLogger(SkillCanonicalizationProcessor.name),
    },
  ],
  exports: [
    SkillRegistryService,
    SkillCanonicalizationService,
    SkillRepository,
    SkillAliasRepository,
    SkillVersionRepository,
    SkillRelationshipRepository,
    PrismaService,
  ],
})
export class SkillsTaxonomyModule {}
