import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// DOC-1a boundary 4 — schema-local idempotency (documents.IdempotencyKey).
//
// Own table + service (NOT consent's) so the consumed-key write participates in
// the SAME $transaction as the Document + DocumentEvent + OutboxEvent write —
// a rolled-back transaction therefore leaves no consumed key behind. Semantics:
//   same key + same request hash      -> replay (return stored result, append nothing)
//   same key + different request hash -> conflict (409)
//   unseen key                        -> proceed
// Uniqueness is (tenant_id, key). Concurrent double-inserts collide on that
// unique index (P2002); the caller re-checks and replays/conflicts.

export type IdempotencyCheck =
  | { kind: 'replay'; response_status: number | null; response_body: unknown }
  | { kind: 'conflict' }
  | { kind: 'proceed' };

@Injectable()
export class DocumentIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Deterministic request hash: sha256 over a key-sorted JSON canonicalization. */
  static hashRequest(payload: unknown): string {
    return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
  }

  static isUniqueViolation(e: unknown): boolean {
    return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';
  }

  /** Pre-check against committed state (outside the write transaction). */
  async lookup(tenant_id: string, key: string, request_hash: string): Promise<IdempotencyCheck> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { tenant_id_key: { tenant_id, key } },
    });
    if (row === null) return { kind: 'proceed' };
    if (row.request_hash === request_hash) {
      return { kind: 'replay', response_status: row.response_status, response_body: row.response_body };
    }
    return { kind: 'conflict' };
  }

}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}
