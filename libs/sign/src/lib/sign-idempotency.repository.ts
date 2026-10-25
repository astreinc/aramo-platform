import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { IdempotencyKeyReuseError, IdempotencyRequestInProgressError } from './domain/envelope-contract-errors.js';

// Aramo Sign Mobile (M-A3 §7 / §8) — request idempotency for the sender's remind
// and document upload. A key is scoped to (tenant, authenticated actor,
// operation, key) and lives 24 hours. The first request claims the key BEFORE it
// runs (so a concurrent duplicate never runs twice), then stores its response; a
// replay with the same body returns that response without running again, and the
// same key with a different body is refused. A failed first attempt releases the
// claim so the client may retry with the same key.

export const SIGN_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const SIGN_IDEMPOTENCY_KEY_MAX = 255;

export interface SignIdempotencyScope {
  tenant_id: string;
  actor_id: string;
  operation: string;
  key: string;
}

export type SignIdempotencyBegin = { kind: 'fresh'; id: string } | { kind: 'replay'; status: number; body: unknown };

// A stable digest of the request (path identity + body), independent of key order.
export function idempotencyRequestHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

@Injectable()
export class SignIdempotencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async begin(scope: SignIdempotencyScope, request_hash: string, now: Date = new Date()): Promise<SignIdempotencyBegin> {
    const expiredBefore = new Date(now.getTime() - SIGN_IDEMPOTENCY_TTL_MS);
    // An expired key is forgotten (keys expire after 24 hours).
    await this.prisma.signIdempotencyKey.deleteMany({
      where: { ...scopeWhere(scope), created_at: { lt: expiredBefore } },
    });
    const id = randomUUID();
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "sign"."SignIdempotencyKey" (id, tenant_id, actor_id, operation, key, request_hash, created_at)
      VALUES (${id}::uuid, ${scope.tenant_id}::uuid, ${scope.actor_id}::uuid, ${scope.operation}, ${scope.key}, ${request_hash}, ${now})
      ON CONFLICT (tenant_id, actor_id, operation, key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 1) return { kind: 'fresh', id };
    const existing = await this.prisma.signIdempotencyKey.findFirst({ where: scopeWhere(scope) });
    // Released between the insert and this read: the caller may retry.
    if (existing === null) throw new IdempotencyRequestInProgressError();
    if (existing.request_hash !== request_hash) throw new IdempotencyKeyReuseError();
    if (existing.response_status === null) throw new IdempotencyRequestInProgressError();
    return { kind: 'replay', status: existing.response_status, body: existing.response_body };
  }

  async complete(id: string, status: number, body: unknown): Promise<void> {
    await this.prisma.signIdempotencyKey.update({ where: { id }, data: { response_status: status, response_body: (body ?? null) as never } });
  }

  async release(id: string): Promise<void> {
    await this.prisma.signIdempotencyKey.deleteMany({ where: { id, response_status: null } });
  }
}

function scopeWhere(scope: SignIdempotencyScope) {
  return { tenant_id: scope.tenant_id, actor_id: scope.actor_id, operation: scope.operation, key: scope.key };
}
