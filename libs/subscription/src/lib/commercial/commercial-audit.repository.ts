import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { canonicalJson } from './commercial-policy.js';

// CCP-A2 — the append-only commercial audit stream, subscription."CommercialAuditEvent".
// The DB rejects UPDATE and DELETE unconditionally (trigger). This repository only
// appends and reads.
//
// Read = live keyset over (created_at DESC, id DESC). created_at is TIMESTAMPTZ(3), so the
// cursor's Date round-trips exactly. The cursor is opaque, versioned and pins a
// fingerprint of the filter set: replaying it under different filters is refused
// (precedent: apps/api skill-review-queue.service.ts).

export const COMMERCIAL_AUDIT_EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{2,99}$/;
export const COMMERCIAL_AUDIT_SUBJECT_PATTERN = /^[a-z][a-z0-9_]*:.+$/;
export const COMMERCIAL_AUDIT_DEFAULT_LIMIT = 50;
export const COMMERCIAL_AUDIT_MAX_LIMIT = 200;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface CommercialAuditEventRow {
  id: string;
  actor_id: string | null;
  actor_type: string;
  actor_role_keys: string[];
  event_type: string;
  is_exception: boolean;
  tenant_id: string | null;
  subject: string;
  change_request_id: string | null;
  policy_version_id: string;
  payload: unknown;
  correlation_id: string;
  created_at: Date;
}

export interface AppendCommercialAuditEventInput {
  actor: { id: string | null; type: 'user' | 'system'; role_keys: readonly string[] };
  event_type: string;
  is_exception?: boolean;
  tenant_id?: string | null;
  subject: string;
  change_request_id?: string | null;
  policy_version_id: string;
  payload?: Record<string, unknown>;
  correlation_id: string;
}

export interface CommercialAuditQuery {
  actor_id?: string;
  event_type?: string;
  tenant_id?: string;
  /** Inclusive lower bound on created_at. */
  from?: Date;
  /** Exclusive upper bound on created_at. */
  to?: Date;
  exception_only?: boolean;
  /** CCP-B5 (handoff §5.7 "Change request" filter). */
  change_request_id?: string;
  /** CCP-B5 (handoff §5.7 "Product" filter): `payload.product_key`. */
  product_key?: string;
  limit?: number;
  cursor?: string;
}

export interface CommercialAuditPage {
  events: CommercialAuditEventRow[];
  next_cursor: string | null;
}

export class CommercialAuditCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialAuditCursorError';
  }
}

const CURSOR_VERSION = 1;

interface CursorState {
  v: number;
  c: string; // created_at, ISO-8601 (ms)
  i: string; // id
  fp: string;
}

function filterFingerprint(q: CommercialAuditQuery): string {
  const canonical = canonicalJson({
    a: q.actor_id ?? null,
    e: q.event_type ?? null,
    t: q.tenant_id ?? null,
    f: q.from?.toISOString() ?? null,
    u: q.to?.toISOString() ?? null,
    x: q.exception_only === true,
    // CCP-B5 filters join the fingerprint only when set, so an A2 cursor keeps its value.
    ...(q.change_request_id !== undefined ? { r: q.change_request_id } : {}),
    ...(q.product_key !== undefined ? { p: q.product_key } : {}),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new CommercialAuditCursorError('malformed cursor');
  }
  const s = parsed as CursorState;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    s.v !== CURSOR_VERSION ||
    typeof s.c !== 'string' ||
    Number.isNaN(new Date(s.c).getTime()) ||
    typeof s.i !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(s.i) ||
    typeof s.fp !== 'string'
  ) {
    throw new CommercialAuditCursorError('unsupported or malformed cursor');
  }
  return s;
}

@Injectable()
export class CommercialAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one event. Pass `tx` to write inside the caller's transaction (the event
   * commits or rolls back with the change it records).
   */
  async append(input: AppendCommercialAuditEventInput, tx?: Tx): Promise<CommercialAuditEventRow> {
    if (!COMMERCIAL_AUDIT_EVENT_TYPE_PATTERN.test(input.event_type)) {
      throw new Error(`invalid commercial audit event_type: ${input.event_type}`);
    }
    if (!COMMERCIAL_AUDIT_SUBJECT_PATTERN.test(input.subject)) {
      throw new Error(`invalid commercial audit subject: ${input.subject}`);
    }
    if (input.actor.type === 'user' && input.actor.id === null) {
      throw new Error('a user actor must carry actor_id');
    }
    const client = tx ?? this.prisma;
    const row = await client.commercialAuditEvent.create({
      data: {
        id: uuidv7(),
        actor_id: input.actor.id,
        actor_type: input.actor.type,
        actor_role_keys: [...input.actor.role_keys].sort(),
        event_type: input.event_type,
        is_exception: input.is_exception ?? false,
        tenant_id: input.tenant_id ?? null,
        subject: input.subject,
        change_request_id: input.change_request_id ?? null,
        policy_version_id: input.policy_version_id,
        payload: (input.payload ?? {}) as object,
        correlation_id: input.correlation_id,
      },
    });
    return row as CommercialAuditEventRow;
  }

  /** One page, newest first, with the filters ANDed. */
  async list(query: CommercialAuditQuery): Promise<CommercialAuditPage> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? COMMERCIAL_AUDIT_DEFAULT_LIMIT)), COMMERCIAL_AUDIT_MAX_LIMIT);
    const fp = filterFingerprint(query);
    let after: CursorState | null = null;
    if (query.cursor !== undefined && query.cursor.length > 0) {
      after = decodeCursor(query.cursor);
      if (after.fp !== fp) throw new CommercialAuditCursorError('cursor filters do not match the current query');
    }

    const and: object[] = [];
    if (query.actor_id !== undefined) and.push({ actor_id: query.actor_id });
    if (query.event_type !== undefined) and.push({ event_type: query.event_type });
    if (query.tenant_id !== undefined) and.push({ tenant_id: query.tenant_id });
    if (query.from !== undefined) and.push({ created_at: { gte: query.from } });
    if (query.to !== undefined) and.push({ created_at: { lt: query.to } });
    if (query.exception_only === true) and.push({ is_exception: true });
    if (query.change_request_id !== undefined) and.push({ change_request_id: query.change_request_id });
    if (query.product_key !== undefined) and.push({ payload: { path: ['product_key'], equals: query.product_key } });
    if (after !== null) {
      const c = new Date(after.c);
      and.push({ OR: [{ created_at: { lt: c } }, { created_at: c, id: { lt: after.i } }] });
    }

    const rows = (await this.prisma.commercialAuditEvent.findMany({
      where: and.length > 0 ? { AND: and } : {},
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as CommercialAuditEventRow[];

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last !== undefined ? encodeCursor({ v: CURSOR_VERSION, c: last.created_at.toISOString(), i: last.id, fp }) : null;
    return { events: page, next_cursor };
  }
}
