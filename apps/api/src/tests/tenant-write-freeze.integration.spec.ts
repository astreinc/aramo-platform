import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  type INestApplication,
  Post,
  UseGuards,
} from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { AramoExceptionFilter, resolveIdentityMigrations } from '@aramo/common';
import { PrismaService, TenantRepository } from '@aramo/identity';

import { TenantWriteFreezeInterceptor } from '../tenant-write-freeze/tenant-write-freeze.interceptor.js';

// Inc-3 PR-3.7 §4 — the live write-freeze proof against real Postgres. A stub
// guard stands in for JwtAuthGuard: it populates request.authContext for a fixed
// tenant/consumer (the "still-valid token" — the point is that the interceptor
// reads LIVE tenant status, not the token, so a token minted before suspension
// is frozen the instant the tenant flips). The interceptor + AramoExceptionFilter
// are wired exactly as apps/api wires them, so the 403 envelope is real.

const TENANT_ID = uuidv7();
let CONSUMER: 'recruiter' | 'platform' = 'recruiter';

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ authContext?: unknown; requestId?: string }>();
    req.authContext = {
      sub: 'u1',
      consumer_type: CONSUMER,
      actor_kind: 'user',
      tenant_id: TENANT_ID,
      scopes: [],
      iat: 0,
      exp: 0,
    };
    req.requestId = 'itest';
    return true;
  }
}

@Controller('__test/write-freeze')
@UseGuards(StubAuthGuard)
class ProbeController {
  @Post()
  write(): { ok: true } {
    return { ok: true };
  }

  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TenantWriteFreezeInterceptor — live suspend/reactivate (real Postgres)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let prisma: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const repoRoot = resolve(__dirname, '../../../..');
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const migrationPath of resolveIdentityMigrations(repoRoot)) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      // Seed the tenant ACTIVE.
      await setup.tenant.create({
        data: { id: TENANT_ID, name: 'Write Freeze Co', status: 'ACTIVE' },
      });
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();

      module = await Test.createTestingModule({
        controllers: [ProbeController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          TenantRepository,
          { provide: APP_INTERCEPTOR, useClass: TenantWriteFreezeInterceptor },
          { provide: APP_FILTER, useClass: AramoExceptionFilter },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.init();
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('ACTIVE tenant: POST writes (200)', async () => {
      CONSUMER = 'recruiter';
      await request(app.getHttpServer())
        .post('/__test/write-freeze')
        .expect(201);
    });

    it('SUSPENDED tenant: POST is frozen (403 TENANT_SUSPENDED) but GET still reads (200)', async () => {
      CONSUMER = 'recruiter';
      await prisma.tenant.update({
        where: { id: TENANT_ID },
        data: { status: 'SUSPENDED' },
      });

      const post = await request(app.getHttpServer())
        .post('/__test/write-freeze')
        .expect(403);
      expect(post.body?.error?.code).toBe('TENANT_SUSPENDED');

      // The still-valid session can READ — the freeze is write-only.
      await request(app.getHttpServer())
        .get('/__test/write-freeze')
        .expect(200);
    });

    it('platform consumer is exempt: POST writes even while SUSPENDED (200)', async () => {
      CONSUMER = 'platform';
      await request(app.getHttpServer())
        .post('/__test/write-freeze')
        .expect(201);
      CONSUMER = 'recruiter';
    });

    it('CLOSED tenant: POST is frozen (403 TENANT_CLOSED)', async () => {
      await prisma.tenant.update({
        where: { id: TENANT_ID },
        data: { status: 'CLOSED' },
      });
      const post = await request(app.getHttpServer())
        .post('/__test/write-freeze')
        .expect(403);
      expect(post.body?.error?.code).toBe('TENANT_CLOSED');
    });

    it('reactivate → POST writes again (200)', async () => {
      await prisma.tenant.update({
        where: { id: TENANT_ID },
        data: { status: 'ACTIVE' },
      });
      await request(app.getHttpServer())
        .post('/__test/write-freeze')
        .expect(201);
    });
  },
);
