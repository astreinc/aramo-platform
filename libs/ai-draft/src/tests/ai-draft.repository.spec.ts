import { describe, expect, it, vi } from 'vitest';
import { makeMockLogger } from '@aramo/common';

import { AiDraftRepository } from '../lib/ai-draft.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-5 §4.15 — AiDraftRepository unit spec. Uses an in-memory
// fake PrismaService.aiDraftEvent surface to validate the 5 closed-list
// event_types and the structured logging contract.

interface FakeRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
}

function makeFakePrisma(): {
  prisma: PrismaService;
  rows: FakeRow[];
} {
  const rows: FakeRow[] = [];
  const prisma = {
    aiDraftEvent: {
      create: vi.fn(async ({ data }: { data: FakeRow }) => {
        rows.push({ ...data });
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: { tenant_id: string } }) =>
          rows.filter((r) => r.tenant_id === where.tenant_id),
      ),
    },
  } as unknown as PrismaService;
  return { prisma, rows };
}

describe('AiDraftRepository', () => {
  it('appendEvent persists request_built event', async () => {
    const { prisma, rows } = makeFakePrisma();
    const repo = new AiDraftRepository(prisma, makeMockLogger());
    const view = await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000001',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'request_built',
      event_payload: { model: 'm', prompt_sha256: 'h', prompt_token_estimate: 1, max_tokens: 1, redacted_span_count_input: 0 },
    });
    expect(view.event_type).toBe('request_built');
    expect(rows).toHaveLength(1);
  });

  it('appendEvent persists request_sent event', async () => {
    const { prisma } = makeFakePrisma();
    const repo = new AiDraftRepository(prisma, makeMockLogger());
    const view = await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000002',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'request_sent',
      event_payload: { model: 'm', retry_attempt: 0 },
    });
    expect(view.event_type).toBe('request_sent');
  });

  it('appendEvent persists response_received event', async () => {
    const { prisma } = makeFakePrisma();
    const repo = new AiDraftRepository(prisma, makeMockLogger());
    const view = await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000003',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'response_received',
      event_payload: {},
    });
    expect(view.event_type).toBe('response_received');
  });

  it('appendEvent persists redaction_applied event', async () => {
    const { prisma } = makeFakePrisma();
    const repo = new AiDraftRepository(prisma, makeMockLogger());
    const view = await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000004',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'redaction_applied',
      event_payload: { kind: 'pre_prompt', count: 1, hashed_input_ref: 'h' },
    });
    expect(view.event_type).toBe('redaction_applied');
  });

  it('appendEvent persists error_raised event', async () => {
    const { prisma } = makeFakePrisma();
    const repo = new AiDraftRepository(prisma, makeMockLogger());
    const view = await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000005',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'error_raised',
      event_payload: { stage: 'response_received', error_code: 'INTERNAL_ERROR', message: 'bang' },
    });
    expect(view.event_type).toBe('error_raised');
  });

  it('logger emits append_started + appended structured payloads (no event_payload contents)', async () => {
    const { prisma } = makeFakePrisma();
    const log = vi.fn();
    const logger = { ...makeMockLogger(), log };
    const repo = new AiDraftRepository(prisma, logger);
    await repo.appendEvent({
      id: '00000000-0000-7000-8000-000000000006',
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'request_built',
      event_payload: { secret_field_that_should_not_be_logged: 'do-not-log-me' },
    });
    expect(log).toHaveBeenCalledTimes(2);
    const firstCall = log.mock.calls[0]?.[0];
    const secondCall = log.mock.calls[1]?.[0];
    expect(firstCall.event).toBe('ai_draft_event.append_started');
    expect(secondCall.event).toBe('ai_draft_event.appended');
    // Neither log line carries event_payload contents.
    expect(JSON.stringify(firstCall)).not.toContain('do-not-log-me');
    expect(JSON.stringify(secondCall)).not.toContain('do-not-log-me');
  });
});
