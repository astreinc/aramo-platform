import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { AiDraftRepository } from '../lib/ai-draft.repository.js';
import { AiDraftService } from '../lib/ai-draft.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import type { DraftProvider } from '../lib/providers/draft-provider.interface.js';
import type { SecretCacheService } from '../lib/secrets/secret-cache.service.js';

// M5 PR-5 §4.15 — integration spec for libs/ai-draft.
//
// Brings up a Postgres 17 testcontainer, applies the ai_draft init
// migration, constructs AiDraftService with a mock DraftProvider +
// mock SecretCacheService, and asserts:
//   - End-to-end happy path emits 3 events (no PII in input/output).
//   - PII in input emits 4 events (incl. redaction_applied:pre_prompt).
//   - PII in output emits 4 events (incl. redaction_applied:post_completion).
//   - Tenant isolation: events appended for tenant A are not readable
//     under tenant B.
//   - DB-trigger defense-in-depth: raw SQL UPDATE on an existing event
//     is rejected by the ai_draft.ai_draft_event_immutable_trigger.

const AI_DRAFT_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525170000_init/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

function makeMockProvider(completion = 'mock-completion'): DraftProvider {
  return {
    async generate() {
      return {
        completion,
        model_used: 'claude-sonnet-4-6',
        input_tokens: 10,
        output_tokens: 5,
        provider_request_id: `msg_${randomUUID()}`,
      };
    },
  };
}

const fakeSecretCache = {} as SecretCacheService;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'libs/ai-draft — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: AiDraftRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrations = [readFileSync(AI_DRAFT_INIT_MIGRATION_PATH, 'utf8')];

      client = new PrismaService(url);
      await client.$connect();
      for (const sql of migrations) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await client.$executeRawUnsafe(trimmed);
        }
      }

      repo = new AiDraftRepository(client, makeMockLogger());
    }, 180_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    it('end-to-end happy path persists 3 events (no PII)', async () => {
      const svc = new AiDraftService(
        makeMockProvider(),
        fakeSecretCache,
        repo,
        makeMockLogger(),
      );
      const result = await svc.generateDraft({
        tenant_id: TENANT_A,
        prompt: 'no-pii prompt',
        max_tokens: 100,
      });
      expect(result.completion).toBe('mock-completion');

      const rows = await repo.findByTenantId(TENANT_A);
      // 3 events for happy path (no redaction).
      const eventTypes = rows.map((r) => r.event_type).sort();
      expect(eventTypes).toContain('request_built');
      expect(eventTypes).toContain('request_sent');
      expect(eventTypes).toContain('response_received');
    });

    it('input PII triggers redaction_applied event (4 events total)', async () => {
      // Use a fresh tenant for clean event count.
      const tenant = '33333333-3333-7333-8333-333333333333';
      const svc = new AiDraftService(
        makeMockProvider(),
        fakeSecretCache,
        repo,
        makeMockLogger(),
      );
      await svc.generateDraft({
        tenant_id: tenant,
        prompt: 'SSN here: 123-45-6789',
        max_tokens: 100,
      });
      const rows = await repo.findByTenantId(tenant);
      const types = rows.map((r) => r.event_type);
      expect(types.filter((t) => t === 'redaction_applied')).toHaveLength(1);
      expect(rows).toHaveLength(4);
    });

    it('output PII triggers redaction_applied event (4 events total)', async () => {
      const tenant = '44444444-4444-7444-8444-444444444444';
      const svc = new AiDraftService(
        makeMockProvider('output email: leak@example.com'),
        fakeSecretCache,
        repo,
        makeMockLogger(),
      );
      const result = await svc.generateDraft({
        tenant_id: tenant,
        prompt: 'clean',
        max_tokens: 100,
      });
      expect(result.completion).toBe('output email: [REDACTED:EMAIL]');
      const rows = await repo.findByTenantId(tenant);
      expect(rows.filter((r) => r.event_type === 'redaction_applied')).toHaveLength(1);
      expect(rows).toHaveLength(4);
    });

    it('tenant isolation: events for TENANT_A not visible under TENANT_B', async () => {
      const isolation_tenant_a = '55555555-5555-7555-8555-555555555555';
      const svc = new AiDraftService(
        makeMockProvider(),
        fakeSecretCache,
        repo,
        makeMockLogger(),
      );
      await svc.generateDraft({
        tenant_id: isolation_tenant_a,
        prompt: 'tenant-A draft',
        max_tokens: 100,
      });
      const rowsA = await repo.findByTenantId(isolation_tenant_a);
      expect(rowsA.length).toBeGreaterThan(0);
      const rowsB = await repo.findByTenantId(TENANT_B);
      // No events ever appended for TENANT_B in this suite.
      expect(rowsB).toEqual([]);
    });

    it('DB-trigger defense-in-depth: raw SQL UPDATE on AiDraftEvent is rejected', async () => {
      // Use repo to insert an event first.
      const tenant = '66666666-6666-7666-8666-666666666666';
      const event = await repo.appendEvent({
        id: randomUUID(),
        tenant_id: tenant,
        event_type: 'request_built',
        event_payload: { model: 'm', prompt_sha256: 'h', prompt_token_estimate: 1, max_tokens: 1, redacted_span_count_input: 0 },
      });
      await expect(
        client.$executeRawUnsafe(
          `UPDATE ai_draft."AiDraftEvent"
             SET event_type = 'error_raised'
             WHERE id = '${event.id}'::uuid`,
        ),
      ).rejects.toThrow(/AiDraftEvent is immutable/);
    });
  },
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
