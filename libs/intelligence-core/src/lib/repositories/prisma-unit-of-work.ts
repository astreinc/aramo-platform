import { Injectable } from '@nestjs/common';

import { IntelligencePrismaService } from '../prisma/intelligence-prisma.service.js';

import { createPrismaRepositories } from './prisma-repositories.js';
import type { IntelligenceRepositories, IntelligenceUnitOfWork, UnitOfWorkOptions } from './types.js';

// ATI-SEP-1 T1 — one interactive Prisma transaction per unit of work. Advisory
// locks are transaction-scoped (released at COMMIT / ROLLBACK) and taken in
// sorted order so two units of work never deadlock on each other's keys.
@Injectable()
export class PrismaIntelligenceUnitOfWork implements IntelligenceUnitOfWork {
  constructor(private readonly prisma: IntelligencePrismaService) {}

  run<T>(fn: (repos: IntelligenceRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const keys = [...new Set(options.lockKeys ?? [])].sort();
        for (const key of keys) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        }
        if (options.repoint) {
          await tx.$executeRaw`SELECT set_config('intelligence.repoint', 'on', true)`;
        }
        return fn(createPrismaRepositories(tx));
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }
}
