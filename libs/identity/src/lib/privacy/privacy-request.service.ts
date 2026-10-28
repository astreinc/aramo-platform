import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type { Prisma } from '../../../prisma/generated/client/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import {
  PRIVACY_STATUS_LABEL,
  PRIVACY_TERMINAL_STATUSES,
  isPrivacyRequestStatus,
  isPrivacyTransitionLegal,
  newPrivacyReference,
  privacyRequestDueAt,
  type PrivacyActorType,
  type PrivacyChannel,
  type PrivacyProduct,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
  type PrivacySubjectKind,
} from './privacy-request.model.js';
import {
  decryptPrivacyEmail,
  encryptPrivacyEmail,
  newPrivacyProofToken,
  privacyEmailHash,
  privacyEmailKeyAvailable,
  privacyProofTokenHash,
} from './privacy-request-crypto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the platform privacy-request record.
// Every request has a durable row with a stable public reference, its type,
// subject kind and channel, a TM-L12 status lifecycle, a 30-day due date, a
// responsible operator, an outcome and append-only events. Every state change
// writes its event in the SAME transaction; a transition is guarded by the
// current status (a concurrent change answers 409, never a lost update).
//
// Products consume this capability (Aramo Sign first): they decide what an
// inventory counts and what execution does; this service owns only the record.

export interface PrivacyActor {
  actor_type: PrivacyActorType;
  actor_id: string | null;
}

export interface PrivacyRequestRecord {
  id: string;
  reference: string;
  product: PrivacyProduct;
  request_type: PrivacyRequestType;
  subject_kind: PrivacySubjectKind;
  channel: PrivacyChannel;
  status: PrivacyRequestStatus;
  subject_user_id: string | null;
  subject_tenant_id: string | null;
  referred_tenant_id: string | null;
  contact_email_hash: string | null;
  contact_email_ciphertext: string | null;
  due_at: Date;
  assigned_operator_id: string | null;
  inventory: Record<string, unknown> | null;
  completion_evidence: Record<string, unknown> | null;
  outcome_code: string | null;
  outcome_text: string | null;
  identity_validated_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PrivacyRequestEventRecord {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** What the requester sees: the identifier, a meaningful status and the outcome. */
export interface PrivacyRequestView {
  reference: string;
  request_type: PrivacyRequestType;
  subject_kind: PrivacySubjectKind;
  channel: PrivacyChannel;
  status: PrivacyRequestStatus;
  status_label: string;
  referred_to_organization: boolean;
  due_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  outcome_code: string | null;
  outcome_text: string | null;
}

/** Fields a transition may set alongside the status (never the identity columns). */
export interface PrivacyTransitionPatch {
  subject_kind?: PrivacySubjectKind;
  subject_user_id?: string | null;
  subject_tenant_id?: string | null;
  referred_tenant_id?: string | null;
  inventory?: Record<string, unknown>;
  completion_evidence?: Record<string, unknown>;
  outcome_code?: string | null;
  outcome_text?: string | null;
}

export const PRIVACY_PROOF_TTL_MS = 60 * 60 * 1000;
export const PRIVACY_OUTCOME_TEXT_MAX = 2000;

type Tx = Prisma.TransactionClient;

function toRecord(row: {
  id: string;
  reference: string;
  product: string;
  request_type: string;
  subject_kind: string;
  channel: string;
  status: string;
  subject_user_id: string | null;
  subject_tenant_id: string | null;
  referred_tenant_id: string | null;
  contact_email_hash: string | null;
  contact_email_ciphertext: string | null;
  due_at: Date;
  assigned_operator_id: string | null;
  inventory: unknown;
  completion_evidence: unknown;
  outcome_code: string | null;
  outcome_text: string | null;
  identity_validated_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): PrivacyRequestRecord {
  return {
    ...row,
    product: row.product as PrivacyProduct,
    request_type: row.request_type as PrivacyRequestType,
    subject_kind: row.subject_kind as PrivacySubjectKind,
    channel: row.channel as PrivacyChannel,
    status: row.status as PrivacyRequestStatus,
    inventory: (row.inventory ?? null) as Record<string, unknown> | null,
    completion_evidence: (row.completion_evidence ?? null) as Record<string, unknown> | null,
  };
}

function conflict(requestId: string, reason: string, details: Record<string, unknown> = {}): AramoError {
  return new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'The privacy request changed or cannot move to that status', 409, { requestId, details: { reason, ...details } });
}

@Injectable()
export class PrivacyRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    product: PrivacyProduct;
    request_type: PrivacyRequestType;
    subject_kind: PrivacySubjectKind;
    channel: PrivacyChannel;
    subject_user_id?: string | null;
    subject_tenant_id?: string | null;
    /** Plain email (web / operator requests); stored only as keyed hash + ciphertext. */
    contact_email?: string | null;
    /** Already-protected email (copied from an email proof). */
    contact_protected?: { hash: string; ciphertext: string } | null;
    actor: PrivacyActor;
    payload?: Record<string, unknown>;
    now?: Date;
  }): Promise<PrivacyRequestRecord> {
    const now = input.now ?? new Date();
    const contact =
      input.contact_protected ??
      (input.contact_email !== undefined && input.contact_email !== null
        ? { hash: privacyEmailHash(input.contact_email), ciphertext: encryptPrivacyEmail(input.contact_email) }
        : null);
    for (let attempt = 0; ; attempt += 1) {
      const id = uuidv7();
      const reference = newPrivacyReference();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const row = await tx.privacyRequest.create({
            data: {
              id,
              reference,
              product: input.product,
              request_type: input.request_type,
              subject_kind: input.subject_kind,
              channel: input.channel,
              status: 'RECEIVED',
              subject_user_id: input.subject_user_id ?? null,
              subject_tenant_id: input.subject_tenant_id ?? null,
              contact_email_hash: contact?.hash ?? null,
              contact_email_ciphertext: contact?.ciphertext ?? null,
              due_at: privacyRequestDueAt(now),
              created_at: now,
              updated_at: now,
            },
          });
          await this.event(tx, id, 'CREATED', null, 'RECEIVED', input.actor, { channel: input.channel, request_type: input.request_type, ...(input.payload ?? {}) }, now);
          return toRecord(row);
        });
      } catch (err) {
        // A reference collision (60 random bits) is retried with a new one.
        if (attempt < 3 && (err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
    }
  }

  /**
   * Move a request to `to` (legal transitions only), with an optional patch and
   * event payload, guarded by the current status. Terminal statuses stamp
   * completed_at. A request already in `to` is answered as is (idempotent).
   */
  async transition(
    id: string,
    to: PrivacyRequestStatus,
    actor: PrivacyActor,
    opts: { patch?: PrivacyTransitionPatch; payload?: Record<string, unknown>; requestId?: string; now?: Date; from?: readonly PrivacyRequestStatus[] } = {},
  ): Promise<PrivacyRequestRecord> {
    const requestId = opts.requestId ?? 'privacy-request';
    const now = opts.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.privacyRequest.findUnique({ where: { id } });
      if (cur === null) throw new AramoError('NOT_FOUND', 'Privacy request not found', 404, { requestId, details: { reason: 'privacy_request_not_found' } });
      const from = cur.status as PrivacyRequestStatus;
      if (!isPrivacyRequestStatus(from)) throw conflict(requestId, 'privacy_request_unknown_status');
      if (from === to && opts.patch === undefined) return toRecord(cur);
      if (opts.from !== undefined && !opts.from.includes(from)) throw conflict(requestId, 'privacy_request_wrong_status', { status: from });
      if (!isPrivacyTransitionLegal(from, to)) throw conflict(requestId, 'privacy_request_illegal_transition', { from, to });
      const patch = opts.patch ?? {};
      if (patch.outcome_text !== undefined && patch.outcome_text !== null && patch.outcome_text.length > PRIVACY_OUTCOME_TEXT_MAX) {
        throw new AramoError('VALIDATION_ERROR', `The outcome text is limited to ${PRIVACY_OUTCOME_TEXT_MAX} characters`, 400, { requestId, details: { reason: 'privacy_outcome_too_long' } });
      }
      const data: Prisma.PrivacyRequestUpdateManyMutationInput = {
        status: to,
        updated_at: now,
        ...(patch.subject_kind !== undefined ? { subject_kind: patch.subject_kind } : {}),
        ...(patch.subject_user_id !== undefined ? { subject_user_id: patch.subject_user_id } : {}),
        ...(patch.subject_tenant_id !== undefined ? { subject_tenant_id: patch.subject_tenant_id } : {}),
        ...(patch.referred_tenant_id !== undefined ? { referred_tenant_id: patch.referred_tenant_id } : {}),
        ...(patch.inventory !== undefined ? { inventory: patch.inventory as Prisma.InputJsonValue } : {}),
        ...(patch.completion_evidence !== undefined ? { completion_evidence: patch.completion_evidence as Prisma.InputJsonValue } : {}),
        ...(patch.outcome_code !== undefined ? { outcome_code: patch.outcome_code } : {}),
        ...(patch.outcome_text !== undefined ? { outcome_text: patch.outcome_text } : {}),
        ...(to === 'IDENTITY_VALIDATED' ? { identity_validated_at: now } : {}),
        ...(PRIVACY_TERMINAL_STATUSES.has(to) ? { completed_at: now } : {}),
      };
      const res = await tx.privacyRequest.updateMany({ where: { id, status: from }, data });
      if (res.count !== 1) throw conflict(requestId, 'privacy_request_concurrent_change');
      await this.event(tx, id, 'STATUS_CHANGED', from, to, actor, opts.payload ?? {}, now);
      const row = await tx.privacyRequest.findUniqueOrThrow({ where: { id } });
      return toRecord(row);
    });
  }

  /** A non-transition event (assignment, referral note, legal hold, failure, operator note). */
  async recordEvent(id: string, event_type: string, actor: PrivacyActor, payload: Record<string, unknown> = {}, now: Date = new Date()): Promise<void> {
    const status = await this.prisma.privacyRequest.findUnique({ where: { id }, select: { status: true } });
    if (status === null) throw new AramoError('NOT_FOUND', 'Privacy request not found', 404, { requestId: 'privacy-request', details: { reason: 'privacy_request_not_found' } });
    await this.prisma.$transaction(async (tx) => {
      await this.event(tx, id, event_type, status.status, status.status, actor, payload, now);
    });
  }

  /** Assigns the responsible Aramo operator (any non-terminal status). */
  async assign(id: string, operator_id: string, actor: PrivacyActor, requestId: string, now: Date = new Date()): Promise<PrivacyRequestRecord> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.privacyRequest.findUnique({ where: { id } });
      if (cur === null) throw new AramoError('NOT_FOUND', 'Privacy request not found', 404, { requestId, details: { reason: 'privacy_request_not_found' } });
      if (PRIVACY_TERMINAL_STATUSES.has(cur.status as PrivacyRequestStatus)) throw conflict(requestId, 'privacy_request_final', { status: cur.status });
      const row = await tx.privacyRequest.update({ where: { id }, data: { assigned_operator_id: operator_id, updated_at: now } });
      await this.event(tx, id, 'ASSIGNED', cur.status, cur.status, actor, { previous_operator_id: cur.assigned_operator_id, operator_id }, now);
      return toRecord(row);
    });
  }

  async findById(id: string): Promise<PrivacyRequestRecord | null> {
    const row = await this.prisma.privacyRequest.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async findByReference(reference: string): Promise<PrivacyRequestRecord | null> {
    const row = await this.prisma.privacyRequest.findUnique({ where: { reference } });
    return row === null ? null : toRecord(row);
  }

  /** The requester's own requests (in-app), newest first. Tenant-scoped. */
  async listForSubject(subject_user_id: string, subject_tenant_id: string, limit = 20): Promise<PrivacyRequestRecord[]> {
    const rows = await this.prisma.privacyRequest.findMany({ where: { subject_user_id, subject_tenant_id }, orderBy: { created_at: 'desc' }, take: limit });
    return rows.map(toRecord);
  }

  /** An open (non-terminal) request of this type for this subject, if any. */
  async findOpenForSubject(subject_user_id: string, subject_tenant_id: string, request_type: PrivacyRequestType): Promise<PrivacyRequestRecord | null> {
    const row = await this.prisma.privacyRequest.findFirst({
      where: { subject_user_id, subject_tenant_id, request_type, status: { notIn: [...PRIVACY_TERMINAL_STATUSES] } },
      orderBy: { created_at: 'desc' },
    });
    return row === null ? null : toRecord(row);
  }

  /** The operator queue: open requests by due date (or a status filter). */
  async listQueue(filter: { status?: PrivacyRequestStatus; request_type?: PrivacyRequestType; include_closed?: boolean; limit?: number } = {}): Promise<PrivacyRequestRecord[]> {
    const rows = await this.prisma.privacyRequest.findMany({
      where: {
        ...(filter.status !== undefined ? { status: filter.status } : filter.include_closed === true ? {} : { status: { notIn: [...PRIVACY_TERMINAL_STATUSES] } }),
        ...(filter.request_type !== undefined ? { request_type: filter.request_type } : {}),
      },
      orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(filter.limit ?? 100, 1), 500),
    });
    return rows.map(toRecord);
  }

  /** Requests of a product waiting in EXECUTING (the product's execution worker). */
  async listExecuting(product: PrivacyProduct, limit = 20): Promise<PrivacyRequestRecord[]> {
    const rows = await this.prisma.privacyRequest.findMany({ where: { product, status: 'EXECUTING' }, orderBy: { updated_at: 'asc' }, take: limit });
    return rows.map(toRecord);
  }

  async events(id: string): Promise<PrivacyRequestEventRecord[]> {
    const rows = await this.prisma.privacyRequestEvent.findMany({ where: { request_id: id }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
    return rows.map((e) => ({ ...e, payload: (e.payload ?? {}) as Record<string, unknown> }));
  }

  /** True when the request's stored contact email equals `email` (keyed-hash compare). */
  contactMatches(record: PrivacyRequestRecord, email: string): boolean {
    if (record.contact_email_hash === null || !privacyEmailKeyAvailable()) return false;
    return record.contact_email_hash === privacyEmailHash(email);
  }

  /** The operator's view of the contact email (null when none is stored or the key is absent). */
  contactEmail(record: PrivacyRequestRecord): string | null {
    if (record.contact_email_ciphertext === null || !privacyEmailKeyAvailable()) return null;
    try {
      return decryptPrivacyEmail(record.contact_email_ciphertext);
    } catch {
      return null;
    }
  }

  view(record: PrivacyRequestRecord): PrivacyRequestView {
    return {
      reference: record.reference,
      request_type: record.request_type,
      subject_kind: record.subject_kind,
      channel: record.channel,
      status: record.status,
      status_label: PRIVACY_STATUS_LABEL[record.status],
      referred_to_organization: record.referred_tenant_id !== null,
      due_at: record.due_at.toISOString(),
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
      completed_at: record.completed_at?.toISOString() ?? null,
      outcome_code: record.outcome_code,
      outcome_text: record.outcome_text,
    };
  }

  // ── Public web requests: the one-time email-ownership proof ──

  /** Proofs issued for this email since `since` (the per-email budget). */
  async proofCountSince(email: string, since: Date): Promise<number> {
    return this.prisma.privacyRequestEmailProof.count({ where: { email_hash: privacyEmailHash(email), created_at: { gte: since } } });
  }

  /** Issues a proof; returns the raw token ONCE (only its SHA-256 is stored). */
  async issueEmailProof(input: { email: string; request_type: PrivacyRequestType; product: PrivacyProduct; now?: Date; ttl_ms?: number }): Promise<{ token: string; proof_id: string; expires_at: Date }> {
    const now = input.now ?? new Date();
    const { token, token_hash } = newPrivacyProofToken();
    const id = uuidv7();
    const expires_at = new Date(now.getTime() + (input.ttl_ms ?? PRIVACY_PROOF_TTL_MS));
    await this.prisma.privacyRequestEmailProof.create({
      data: {
        id,
        token_hash,
        email_hash: privacyEmailHash(input.email),
        email_ciphertext: encryptPrivacyEmail(input.email),
        product: input.product,
        request_type: input.request_type,
        expires_at,
        created_at: now,
      },
    });
    return { token, proof_id: id, expires_at };
  }

  /**
   * Consumes a proof token. First use: marks it consumed and returns the proven
   * email. A repeat within its validity (a page reload) returns the request it
   * already created. Unknown, expired or malformed tokens answer null.
   */
  async consumeEmailProof(
    token: string,
    now: Date = new Date(),
  ): Promise<
    | { kind: 'fresh'; proof_id: string; email: string; contact: { hash: string; ciphertext: string }; request_type: PrivacyRequestType; product: PrivacyProduct }
    | { kind: 'repeat'; request_id: string }
    | null
  > {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const token_hash = privacyProofTokenHash(token);
    const proof = await this.prisma.privacyRequestEmailProof.findUnique({ where: { token_hash } });
    if (proof === null || proof.expires_at.getTime() <= now.getTime()) return null;
    if (proof.consumed_at !== null) return proof.request_id !== null ? { kind: 'repeat', request_id: proof.request_id } : null;
    const won = await this.prisma.privacyRequestEmailProof.updateMany({ where: { id: proof.id, consumed_at: null }, data: { consumed_at: now } });
    if (won.count !== 1) {
      const again = await this.prisma.privacyRequestEmailProof.findUnique({ where: { id: proof.id } });
      return again?.request_id ? { kind: 'repeat', request_id: again.request_id } : null;
    }
    return {
      kind: 'fresh',
      proof_id: proof.id,
      email: decryptPrivacyEmail(proof.email_ciphertext),
      contact: { hash: proof.email_hash, ciphertext: proof.email_ciphertext },
      request_type: proof.request_type as PrivacyRequestType,
      product: proof.product as PrivacyProduct,
    };
  }

  async linkProof(proof_id: string, request_id: string): Promise<void> {
    await this.prisma.privacyRequestEmailProof.update({ where: { id: proof_id }, data: { request_id } });
  }

  private async event(tx: Tx, request_id: string, event_type: string, from_status: string | null, to_status: string | null, actor: PrivacyActor, payload: Record<string, unknown>, now: Date): Promise<void> {
    await tx.privacyRequestEvent.create({
      data: { id: uuidv7(), request_id, event_type, from_status, to_status, actor_type: actor.actor_type, actor_id: actor.actor_id, payload: payload as Prisma.InputJsonValue, created_at: now },
    });
  }
}
