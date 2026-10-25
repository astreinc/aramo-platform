import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import {
  type ApprovalRefusal,
  type EligibilityActor,
  type EligibilityResult,
  assertChainStillSatisfiableAtApply,
  checkApprovalEligibility,
  checkChainSatisfiable,
} from './commercial-approval-eligibility.js';
import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_OPEN_STATES,
  COMMERCIAL_REQUEST_PRODUCT_KEYS,
  type CommercialActionType,
  type CommercialChangeRequestKind,
  type CommercialChangeRequestState,
  type CommercialRequiredChain,
  parseRequiredChain,
  payloadChecksum,
  resolveRequiredChain,
  subjectUserOf,
  validatePayload,
} from './commercial-change-request.js';
import { approvalExpiresAt } from './commercial-policy-boundaries.js';
import { canonicalJson } from './commercial-policy.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { CommercialOperatorRepository, type LiveOperator } from './commercial-operator.repository.js';

// CCP-A3 (PBD §5.1 row A3) — the change-request and approval service. Every write runs in
// ONE subscription transaction that locks the request row (`SELECT … FOR UPDATE`), reads
// the actor's roles, scopes and D9 attestation LIVE (NC-4), decides with the pure engine
// (commercial-approval-eligibility.ts) and appends a CommercialAuditEvent for every
// request and approval act — including refused approval attempts, whose audit row is the
// only thing such a transaction writes.
//
// A3 applies nothing (A6). No domain data mutates. `assertApplyEligible` is the NC-5
// apply-time re-check A6 calls inside its own transaction; it is read-only.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export const COMMERCIAL_CLOCK = Symbol('COMMERCIAL_CLOCK');
export type CommercialClock = () => Date;

export interface CommercialActor {
  user_id: string;
  /** The verified token's actor_kind. */
  actor_kind: string;
  /** The server-resolved effective scopes of this request (JwtAuthGuard). */
  scopes: readonly string[];
}

export interface CommercialCallContext {
  platform_tenant_id: string;
  correlation_id: string;
}

export type CommercialChangeRequestErrorCode =
  | 'NOT_FOUND'
  | 'NOT_HUMAN'
  | 'NOT_REQUESTER'
  | 'REQUESTER_SCOPE_MISSING'
  | 'REQUESTER_AUTHORITY_UNDEFINED'
  | 'KIND_NOT_SUPPORTED'
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'STATE_INVALID'
  | 'OPEN_REQUEST_EXISTS'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'INTEGRITY'
  // CCP-A6 — apply was asked for an action type A6 does not apply.
  | 'ACTION_NOT_APPLICABLE';

export class CommercialChangeRequestError extends Error {
  constructor(
    readonly code: CommercialChangeRequestErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CommercialChangeRequestError';
  }
}

/** One of the seven approval refusals (the refusal is audited before this is thrown). */
export class CommercialApprovalRefusedError extends Error {
  constructor(
    readonly refusal: ApprovalRefusal,
    readonly detail: Record<string, unknown>,
  ) {
    super(`approval refused (${refusal})`);
    this.name = 'CommercialApprovalRefusedError';
  }
}

/** The specific chain cannot be fulfilled by independent eligible humans (A9 gate). */
export class CommercialNotBootstrappedError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super('the approval chain cannot be fulfilled by independent eligible humans');
    this.name = 'CommercialNotBootstrappedError';
  }
}

export interface CommercialChangeRequestRow {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: unknown;
  payload_checksum: string;
  required_chain: unknown;
  policy_version_id: string;
  policy_checksum: string;
  requested_by: string;
  reason: string;
  idempotency_key: string;
  created_at: Date;
  submitted_at: Date | null;
  expires_at: Date | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  withdrawn_at: Date | null;
  expired_at: Date | null;
  apply_attempts: number;
  applied_at: Date | null;
  updated_at: Date;
}

export interface CommercialApprovalRow {
  id: string;
  change_request_id: string;
  step_index: number;
  approver_user_id: string;
  step_role_key: string;
  step_scope_keys: string[];
  approver_role_keys: string[];
  attestation_id: string;
  comment: string | null;
  created_at: Date;
}

export interface CreateChangeRequestInput {
  action_type: CommercialActionType;
  kind?: CommercialChangeRequestKind;
  tenant_id?: string | null;
  product_key?: string | null;
  payload: unknown;
  reason: string;
  idempotency_key: string;
}

export interface StepView {
  step_index: number;
  role_key: string;
  scope_keys: string[];
  status: 'APPROVED' | 'NEXT' | 'WAITING';
  approval: CommercialApprovalRow | null;
  /** The caller's verdict for this step (null once the step is approved). */
  caller: { eligible: boolean; refusal: ApprovalRefusal | null } | null;
}

export interface ChangeRequestView {
  request: CommercialChangeRequestRow;
  approvals: CommercialApprovalRow[];
  chain: CommercialRequiredChain;
  /** PENDING_APPROVAL past expires_at, not yet transitioned (it will be on the next act). */
  is_expired: boolean;
  steps: StepView[];
  /** Chain satisfiability now (A9 gate) for an open PENDING request; null otherwise. */
  chain_satisfiable: boolean | null;
}

export interface ListChangeRequestsQuery {
  state?: CommercialChangeRequestState;
  requested_by?: string;
  eligible_for_me?: boolean;
  limit?: number;
  cursor?: string;
}

export class CommercialChangeRequestCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialChangeRequestCursorError';
  }
}

const SUBJECT = (id: string): string => `commercial_change_request:${id}`;
const ELIGIBLE_FOR_ME_SCAN = 500;

function isUniqueViolation(e: unknown, target: string): boolean {
  const err = e as { code?: string; meta?: { target?: unknown; constraint?: unknown }; message?: string };
  if (err?.code !== 'P2002') return false;
  const blob = JSON.stringify(err.meta ?? {}) + String(err.message ?? '');
  return blob.includes(target);
}

@Injectable()
export class CommercialChangeRequestService {
  private readonly now: CommercialClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommercialAuditRepository,
    private readonly policies: CommercialPolicyRepository,
    private readonly operators: CommercialOperatorRepository,
    @Optional() @Inject(COMMERCIAL_CLOCK) clock?: CommercialClock,
  ) {
    this.now = clock ?? (() => new Date());
  }

  // ---- create ---------------------------------------------------------------------------

  /** DRAFT creation. Idempotent on `idempotency_key` (same requester + same request). */
  async create(actor: CommercialActor, input: CreateChangeRequestInput, ctx: CommercialCallContext): Promise<{ request: CommercialChangeRequestRow; replayed: boolean }> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can request a commercial change');
    const def = COMMERCIAL_ACTIONS[input.action_type];
    const kind = input.kind ?? 'NORMAL';
    if (kind !== 'NORMAL') {
      // EXCEPTION is created by the CCP-A8 bounded path, MIGRATION by the CCP-A11 backfill.
      throw new CommercialChangeRequestError('KIND_NOT_SUPPORTED', `kind ${kind} is not created through this path`, { kind });
    }
    if (def.requester_scope === null) {
      throw new CommercialChangeRequestError('REQUESTER_AUTHORITY_UNDEFINED', `no requester authority is defined for ${input.action_type} yet`, { action_type: input.action_type });
    }
    if (!actor.scopes.includes(def.requester_scope)) {
      throw new CommercialChangeRequestError('REQUESTER_SCOPE_MISSING', `requesting ${input.action_type} requires ${def.requester_scope}`, { missing_scopes: [def.requester_scope] });
    }
    const tenant_id = input.tenant_id ?? null;
    const product_key = input.product_key ?? null;
    if (def.tenant_scoped) {
      if (tenant_id === null || product_key === null) throw new CommercialChangeRequestError('INVALID_INPUT', `${input.action_type} requires tenant_id and product_key`, { reason: 'tenant_product_required' });
      if (!(COMMERCIAL_REQUEST_PRODUCT_KEYS as readonly string[]).includes(product_key)) {
        throw new CommercialChangeRequestError('INVALID_INPUT', `unknown product_key ${product_key}`, { reason: 'unknown_product_key' });
      }
      if (tenant_id === ctx.platform_tenant_id) throw new CommercialChangeRequestError('INVALID_INPUT', 'the platform tenant is not a commercial tenant', { reason: 'platform_tenant' });
    } else if (tenant_id !== null || product_key !== null) {
      throw new CommercialChangeRequestError('INVALID_INPUT', `${input.action_type} carries no tenant_id or product_key`, { reason: 'tenant_product_not_allowed' });
    }
    const payload = (() => {
      try {
        return validatePayload(input.action_type, input.payload);
      } catch (e) {
        throw new CommercialChangeRequestError('INVALID_INPUT', (e as Error).message, { reason: 'invalid_payload', errors: (e as { errors?: unknown }).errors ?? [] });
      }
    })();
    const checksum = payloadChecksum(payload);
    const fingerprint = { action_type: input.action_type, kind, tenant_id, product_key, payload_checksum: checksum, reason: input.reason, requested_by: actor.user_id };

    const replay = await this.replayOf(input.idempotency_key, fingerprint);
    if (replay !== null) return { request: replay, replayed: true };

    const policy = await this.policies.getActivePolicy();
    const chain = resolveRequiredChain(input.action_type, payload, policy.content);
    const now = this.now();
    const id = uuidv7();
    try {
      const request = await this.tx(async (tx) => {
        if (def.tenant_scoped) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ccp:change_request:${tenant_id}:${product_key}`}, 0))`;
          const tenant = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
          if ((tenant[0]?.n ?? 0) !== 1) throw new CommercialChangeRequestError('TENANT_NOT_FOUND', 'tenant not found', { tenant_id });
          await this.expireOpenFor(tx, tenant_id as string, product_key as string, now, ctx);
          const open = await tx.commercialChangeRequest.findFirst({
            where: { tenant_id, product_key, state: { in: [...COMMERCIAL_OPEN_STATES] } },
            select: { id: true, state: true },
          });
          if (open !== null) {
            throw new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'an open change request already exists for this tenant and product', { open_request_id: open.id, open_state: open.state });
          }
        }
        const requester = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id);
        const row = await tx.commercialChangeRequest.create({
          data: {
            id,
            action_type: input.action_type,
            kind,
            state: 'DRAFT',
            tenant_id,
            product_key,
            payload: payload as object,
            payload_checksum: checksum,
            required_chain: chain as unknown as object,
            policy_version_id: policy.version_id,
            policy_checksum: policy.checksum,
            requested_by: actor.user_id,
            reason: input.reason,
            idempotency_key: input.idempotency_key,
            created_at: now,
            updated_at: now,
          },
        });
        await this.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys: requester.role_keys },
            event_type: 'COMMERCIAL_CHANGE_REQUEST_CREATED',
            tenant_id,
            subject: SUBJECT(id),
            change_request_id: id,
            policy_version_id: policy.version_id,
            payload: {
              action_type: input.action_type,
              kind,
              product_key,
              payload_checksum: checksum,
              policy_checksum: policy.checksum,
              chain_rule: chain.rule,
              chain_basis: chain.basis,
              steps: chain.steps.map((s) => s.role_key),
            },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        return row as CommercialChangeRequestRow;
      });
      return { request, replayed: false };
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency_key')) {
        const again = await this.replayOf(input.idempotency_key, fingerprint);
        if (again !== null) return { request: again, replayed: true };
      }
      if (isUniqueViolation(e, 'one_open_per_tenant_product') || isUniqueViolation(e, 'tenant_id')) {
        throw new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'an open change request already exists for this tenant and product', {});
      }
      throw e;
    }
  }

  private async replayOf(key: string, fp: Record<string, unknown>): Promise<CommercialChangeRequestRow | null> {
    const existing = (await this.prisma.commercialChangeRequest.findUnique({ where: { idempotency_key: key } })) as CommercialChangeRequestRow | null;
    if (existing === null) return null;
    const same =
      existing.action_type === fp['action_type'] &&
      existing.kind === fp['kind'] &&
      existing.tenant_id === fp['tenant_id'] &&
      existing.product_key === fp['product_key'] &&
      existing.payload_checksum === fp['payload_checksum'] &&
      existing.reason === fp['reason'] &&
      existing.requested_by === fp['requested_by'];
    if (!same) throw new CommercialChangeRequestError('IDEMPOTENCY_KEY_CONFLICT', 'the idempotency key was used for a different request', { change_request_id: existing.id });
    return existing;
  }

  // ---- submit / withdraw ----------------------------------------------------------------

  async submit(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<CommercialChangeRequestRow> {
    return this.tx(async (tx) => {
      const req = await this.lock(tx, id);
      this.requireRequester(actor, req);
      if (req.state !== 'DRAFT') throw new CommercialChangeRequestError('STATE_INVALID', `cannot submit a ${req.state} request`, { state: req.state });
      // The request's OWN policy version (NC-5), never the currently ACTIVE one.
      const policy = await this.policies.getVersionPolicy(req.policy_version_id, tx);
      if (policy.checksum !== req.policy_checksum) throw new CommercialChangeRequestError('INTEGRITY', 'policy snapshot checksum mismatch', { reason: 'policy_checksum' });
      const now = this.now();
      const expires_at = approvalExpiresAt(policy.content, now);
      const row = (await tx.commercialChangeRequest.update({
        where: { id },
        data: { state: 'PENDING_APPROVAL', submitted_at: now, expires_at, updated_at: now },
      })) as CommercialChangeRequestRow;
      await this.appendEvent(tx, actor, req, 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED', { expires_at: expires_at.toISOString(), approval_expiry_hours: policy.content.approval_expiry_hours }, ctx);
      return row;
    });
  }

  async withdraw(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<CommercialChangeRequestRow> {
    const out = await this.tx(async (tx) => {
      const req = await this.lock(tx, id);
      this.requireRequester(actor, req);
      const now = this.now();
      if (await this.expireIfDue(tx, req, now, ctx)) return { expired: true as const, row: null };
      if (req.state !== 'DRAFT' && req.state !== 'PENDING_APPROVAL') {
        throw new CommercialChangeRequestError('STATE_INVALID', `cannot withdraw a ${req.state} request`, { state: req.state });
      }
      const row = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'WITHDRAWN', withdrawn_at: now, updated_at: now } })) as CommercialChangeRequestRow;
      await this.appendEvent(tx, actor, req, 'COMMERCIAL_CHANGE_REQUEST_WITHDRAWN', { from_state: req.state }, ctx);
      return { expired: false as const, row };
    });
    if (out.expired) throw new CommercialChangeRequestError('STATE_INVALID', 'the request has expired', { state: 'EXPIRED' });
    return out.row as CommercialChangeRequestRow;
  }

  // ---- approve / reject -----------------------------------------------------------------

  /**
   * Approves `step_index`. Order inside the transaction: lock the request; integrity
   * (payload checksum); expiry (an expired request transitions to EXPIRED); the A9 chain
   * gate for a PENDING request (409 CCP_NOT_BOOTSTRAPPED); the seven refusals with live
   * eligibility; then the append-only approval row, and APPROVED when the last step fills.
   */
  async approve(actor: CommercialActor, id: string, input: { step_index: number; comment?: string | null }, ctx: CommercialCallContext): Promise<{ request: CommercialChangeRequestRow; approval: CommercialApprovalRow }> {
    const out = await this.tx(async (tx) => {
      const req = await this.lock(tx, id);
      this.verifyIntegrity(req);
      const now = this.now();
      const live = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id, true);
      if (await this.expireIfDue(tx, req, now, ctx)) {
        const detail = { expires_at: req.expires_at?.toISOString() ?? null };
        await this.appendEvent(tx, actor, req, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'EXPIRED', detail, requested_step: input.step_index }, ctx, live.role_keys);
        return { kind: 'refused' as const, refusal: 'EXPIRED' as ApprovalRefusal, detail };
      }
      const current = req;
      const chain = parseRequiredChain(current.required_chain);
      const approvals = await this.approvalsOf(tx, id);
      const subject = subjectUserOf(current.action_type, current.payload);

      if (current.state === 'PENDING_APPROVAL') {
        const roster = await this.operators.readRoster(tx, ctx.platform_tenant_id, { lock: true });
        const exclude = new Set<string>([current.requested_by, ...approvals.map((a) => a.approver_user_id), ...(subject === null ? [] : [subject])]);
        const gate = checkChainSatisfiable(chain.steps.slice(approvals.length), roster, exclude);
        if (!gate.satisfiable) {
          const detail = { action_type: current.action_type, chain_rule: chain.rule, unfillable_steps: gate.unfillable_steps, filled_steps: approvals.length };
          await this.appendEvent(tx, actor, current, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'CCP_NOT_BOOTSTRAPPED', ...detail, requested_step: input.step_index }, ctx, live.role_keys);
          return { kind: 'not_bootstrapped' as const, detail };
        }
      }

      const verdict = checkApprovalEligibility(
        { state: current.state, requested_by: current.requested_by, expires_at: current.expires_at, required_chain: chain, subject_user_id: subject },
        approvals,
        this.eligibilityActor(actor, live),
        now,
        input.step_index,
      );
      if (!verdict.eligible) {
        await this.appendEvent(tx, actor, current, 'COMMERCIAL_APPROVAL_REFUSED', { refusal: verdict.refusal, detail: verdict.detail, requested_step: input.step_index }, ctx, live.role_keys);
        return { kind: 'refused' as const, refusal: verdict.refusal, detail: verdict.detail };
      }
      const approval = (await tx.commercialApproval.create({
        data: {
          id: uuidv7(),
          change_request_id: id,
          step_index: verdict.step_index,
          approver_user_id: actor.user_id,
          step_role_key: verdict.step.role_key,
          step_scope_keys: verdict.step.scope_keys,
          approver_role_keys: [...live.role_keys],
          attestation_id: live.attestation_id as string,
          comment: input.comment ?? null,
          created_at: now,
        },
      })) as CommercialApprovalRow;
      await this.appendEvent(tx, actor, current, 'COMMERCIAL_APPROVAL_RECORDED', { approval_id: approval.id, step_index: approval.step_index, step_role_key: approval.step_role_key, attestation_id: approval.attestation_id }, ctx, live.role_keys);
      let row = current;
      if (verdict.step_index === chain.steps.length - 1) {
        row = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPROVED', approved_at: now, updated_at: now } })) as CommercialChangeRequestRow;
        await this.appendEvent(tx, actor, current, 'COMMERCIAL_CHANGE_REQUEST_APPROVED', { approvals: chain.steps.length, chain_rule: chain.rule }, ctx, live.role_keys);
      }
      return { kind: 'approved' as const, request: row, approval };
    });
    if (out.kind === 'not_bootstrapped') throw new CommercialNotBootstrappedError(out.detail);
    if (out.kind === 'refused') throw new CommercialApprovalRefusedError(out.refusal, out.detail);
    return { request: out.request, approval: out.approval };
  }

  /** Rejection by a checker eligible for the next unfilled step (same seven refusals). */
  async reject(actor: CommercialActor, id: string, input: { reason: string }, ctx: CommercialCallContext): Promise<CommercialChangeRequestRow> {
    const out = await this.tx(async (tx) => {
      const req = await this.lock(tx, id);
      const now = this.now();
      const live = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id, true);
      if (await this.expireIfDue(tx, req, now, ctx)) {
        const detail = { expires_at: req.expires_at?.toISOString() ?? null };
        await this.appendEvent(tx, actor, req, 'COMMERCIAL_REJECTION_REFUSED', { refusal: 'EXPIRED', detail }, ctx, live.role_keys);
        return { kind: 'refused' as const, refusal: 'EXPIRED' as ApprovalRefusal, detail };
      }
      const current = req;
      const chain = parseRequiredChain(current.required_chain);
      const approvals = await this.approvalsOf(tx, id);
      const verdict = checkApprovalEligibility(
        { state: current.state, requested_by: current.requested_by, expires_at: current.expires_at, required_chain: chain, subject_user_id: subjectUserOf(current.action_type, current.payload) },
        approvals,
        this.eligibilityActor(actor, live),
        now,
      );
      if (!verdict.eligible) {
        await this.appendEvent(tx, actor, current, 'COMMERCIAL_REJECTION_REFUSED', { refusal: verdict.refusal, detail: verdict.detail }, ctx, live.role_keys);
        return { kind: 'refused' as const, refusal: verdict.refusal, detail: verdict.detail };
      }
      const row = (await tx.commercialChangeRequest.update({
        where: { id },
        data: { state: 'REJECTED', rejected_at: now, rejected_by: actor.user_id, rejection_reason: input.reason, updated_at: now },
      })) as CommercialChangeRequestRow;
      await this.appendEvent(tx, actor, current, 'COMMERCIAL_CHANGE_REQUEST_REJECTED', { step_index: verdict.step_index, reason: input.reason }, ctx, live.role_keys);
      return { kind: 'rejected' as const, row };
    });
    if (out.kind === 'refused') throw new CommercialApprovalRefusedError(out.refusal, out.detail);
    return out.row;
  }

  // ---- apply-time re-check (NC-5; called by CCP-A6) -------------------------------------

  /**
   * Read-only. Inside the caller's apply transaction (pass `tx`), after locking the request:
   * re-checks every recorded approval against the request's SNAPSHOTTED chain and the live
   * roster. Throws CommercialApplyRefusedError on lost eligibility; writes nothing.
   */
  async assertApplyEligible(id: string, platform_tenant_id: string, tx?: Tx): Promise<void> {
    const run = async (t: Tx): Promise<void> => {
      const req = await this.lock(t, id);
      this.verifyIntegrity(req);
      const approvals = await this.approvalsOf(t, id);
      const roster = await this.operators.readRoster(t, platform_tenant_id, { user_ids: approvals.map((a) => a.approver_user_id), lock: true });
      assertChainStillSatisfiableAtApply(
        { id, state: req.state, requested_by: req.requested_by, subject_user_id: subjectUserOf(req.action_type, req.payload), required_chain: parseRequiredChain(req.required_chain), approvals },
        roster,
      );
    };
    if (tx !== undefined) return run(tx);
    return this.tx(run);
  }

  // ---- expiry sweep ---------------------------------------------------------------------

  /** Transitions every PENDING_APPROVAL request whose expiry has passed (half-open). */
  async expireDue(ctx: CommercialCallContext): Promise<number> {
    const now = this.now();
    const due = await this.prisma.commercialChangeRequest.findMany({ where: { state: 'PENDING_APPROVAL', expires_at: { lte: now } }, select: { id: true } });
    let n = 0;
    for (const { id } of due) {
      await this.tx(async (tx) => {
        const req = await this.lock(tx, id);
        if (await this.expireIfDue(tx, req, now, ctx)) n += 1;
      });
    }
    return n;
  }

  // ---- reads ----------------------------------------------------------------------------

  async get(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<ChangeRequestView> {
    const req = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (req === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    const approvals = await this.approvalsOf(this.prisma, id);
    const live = await this.operators.readOperator(this.prisma, ctx.platform_tenant_id, actor.user_id);
    let satisfiable: boolean | null = null;
    const chain = parseRequiredChain(req.required_chain);
    const now = this.now();
    const is_expired = req.state === 'PENDING_APPROVAL' && req.expires_at !== null && now.getTime() >= req.expires_at.getTime();
    if (req.state === 'PENDING_APPROVAL' && !is_expired) {
      const roster = await this.operators.readRoster(this.prisma, ctx.platform_tenant_id);
      const subject = subjectUserOf(req.action_type, req.payload);
      const exclude = new Set<string>([req.requested_by, ...approvals.map((a) => a.approver_user_id), ...(subject === null ? [] : [subject])]);
      satisfiable = checkChainSatisfiable(chain.steps.slice(approvals.length), roster, exclude).satisfiable;
    }
    return { request: req, approvals, chain, is_expired, steps: this.stepViews(actor, live, req, chain, approvals, now), chain_satisfiable: satisfiable };
  }

  async list(actor: CommercialActor, query: ListChangeRequestsQuery, ctx: CommercialCallContext): Promise<{ requests: CommercialChangeRequestRow[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 200);
    if (query.eligible_for_me === true) {
      // Bounded scan of the open PENDING set, filtered by the caller's live verdict. Not
      // paged (next_cursor null); the open set is small by construction (Q14 + 72 h TTL).
      const rows = (await this.prisma.commercialChangeRequest.findMany({
        where: { state: 'PENDING_APPROVAL', ...(query.requested_by === undefined ? {} : { requested_by: query.requested_by }) },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: ELIGIBLE_FOR_ME_SCAN,
      })) as CommercialChangeRequestRow[];
      if (query.state !== undefined && query.state !== 'PENDING_APPROVAL') return { requests: [], next_cursor: null };
      const live = await this.operators.readOperator(this.prisma, ctx.platform_tenant_id, actor.user_id);
      const now = this.now();
      const out: CommercialChangeRequestRow[] = [];
      for (const r of rows) {
        const approvals = await this.approvalsOf(this.prisma, r.id);
        const v = this.verdictFor(actor, live, r, parseRequiredChain(r.required_chain), approvals, now);
        if (v.eligible) out.push(r);
        if (out.length >= limit) break;
      }
      return { requests: out, next_cursor: null };
    }
    const fp = createHash('sha256').update(canonicalJson({ s: query.state ?? null, r: query.requested_by ?? null }), 'utf8').digest('hex').slice(0, 16);
    const and: object[] = [];
    if (query.state !== undefined) and.push({ state: query.state });
    if (query.requested_by !== undefined) and.push({ requested_by: query.requested_by });
    if (query.cursor !== undefined && query.cursor.length > 0) {
      let c: { v?: number; c?: string; i?: string; fp?: string };
      try {
        c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new CommercialChangeRequestCursorError('malformed cursor');
      }
      if (c?.v !== 1 || typeof c.c !== 'string' || typeof c.i !== 'string' || Number.isNaN(new Date(c.c).getTime())) throw new CommercialChangeRequestCursorError('unsupported or malformed cursor');
      if (c.fp !== fp) throw new CommercialChangeRequestCursorError('cursor filters do not match the current query');
      const at = new Date(c.c);
      and.push({ OR: [{ created_at: { lt: at } }, { created_at: at, id: { lt: c.i } }] });
    }
    const rows = (await this.prisma.commercialChangeRequest.findMany({
      where: and.length > 0 ? { AND: and } : {},
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as CommercialChangeRequestRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last !== undefined ? Buffer.from(JSON.stringify({ v: 1, c: last.created_at.toISOString(), i: last.id, fp }), 'utf8').toString('base64url') : null;
    return { requests: page, next_cursor };
  }

  // ---- internals ------------------------------------------------------------------------

  // A concurrent approver waits on the row lock inside this budget (NC-1).
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 15_000, maxWait: 10_000 });
  }

  private eligibilityActor(actor: CommercialActor, live: LiveOperator): EligibilityActor {
    return { user_id: actor.user_id, actor_kind: actor.actor_kind, attested: live.attested, role_keys: live.role_keys, scopes: live.scopes };
  }

  private verdictFor(actor: CommercialActor, live: LiveOperator, req: CommercialChangeRequestRow, chain: CommercialRequiredChain, approvals: CommercialApprovalRow[], now: Date, step?: number): EligibilityResult {
    return checkApprovalEligibility(
      { state: req.state, requested_by: req.requested_by, expires_at: req.expires_at, required_chain: chain, subject_user_id: subjectUserOf(req.action_type, req.payload) },
      approvals,
      this.eligibilityActor(actor, live),
      now,
      step,
    );
  }

  private stepViews(actor: CommercialActor, live: LiveOperator, req: CommercialChangeRequestRow, chain: CommercialRequiredChain, approvals: CommercialApprovalRow[], now: Date): StepView[] {
    return chain.steps.map((s) => {
      const approval = approvals.find((a) => a.step_index === s.step_index) ?? null;
      const status: StepView['status'] = approval !== null ? 'APPROVED' : s.step_index === approvals.length ? 'NEXT' : 'WAITING';
      let caller: StepView['caller'] = null;
      if (approval === null) {
        const v = this.verdictFor(actor, live, req, chain, approvals, now, s.step_index);
        caller = v.eligible ? { eligible: true, refusal: null } : { eligible: false, refusal: v.refusal };
      }
      return { step_index: s.step_index, role_key: s.role_key, scope_keys: s.scope_keys, status, approval, caller };
    });
  }

  private async lock(tx: Tx, id: string): Promise<CommercialChangeRequestRow> {
    await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, id);
    const row = (await tx.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (row === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    return row;
  }

  private async approvalsOf(client: Pick<PrismaService, 'commercialApproval'>, id: string): Promise<CommercialApprovalRow[]> {
    return (await client.commercialApproval.findMany({ where: { change_request_id: id }, orderBy: { step_index: 'asc' } })) as CommercialApprovalRow[];
  }

  private requireRequester(actor: CommercialActor, req: CommercialChangeRequestRow): void {
    if (actor.user_id !== req.requested_by) throw new CommercialChangeRequestError('NOT_REQUESTER', 'only the requester can do this', { reason: 'not_requester' });
  }

  private verifyIntegrity(req: CommercialChangeRequestRow): void {
    try {
      parseRequiredChain(req.required_chain);
    } catch (e) {
      throw new CommercialChangeRequestError('INTEGRITY', (e as Error).message, { reason: 'required_chain' });
    }
    if (payloadChecksum(req.payload) !== req.payload_checksum) {
      throw new CommercialChangeRequestError('INTEGRITY', 'payload checksum mismatch', { reason: 'payload_checksum' });
    }
  }

  /** PENDING past expiry → EXPIRED (+ audit). Returns true when it transitioned. */
  private async expireIfDue(tx: Tx, req: CommercialChangeRequestRow, now: Date, ctx: CommercialCallContext): Promise<boolean> {
    if (req.state !== 'PENDING_APPROVAL' || req.expires_at === null || now.getTime() < req.expires_at.getTime()) return false;
    await tx.commercialChangeRequest.update({ where: { id: req.id }, data: { state: 'EXPIRED', expired_at: now, updated_at: now } });
    await this.audit.append(
      {
        actor: { id: null, type: 'system', role_keys: [] },
        event_type: 'COMMERCIAL_CHANGE_REQUEST_EXPIRED',
        tenant_id: req.tenant_id,
        subject: SUBJECT(req.id),
        change_request_id: req.id,
        policy_version_id: req.policy_version_id,
        payload: { expires_at: req.expires_at.toISOString() },
        correlation_id: ctx.correlation_id,
      },
      tx,
    );
    return true;
  }

  private async expireOpenFor(tx: Tx, tenant_id: string, product_key: string, now: Date, ctx: CommercialCallContext): Promise<void> {
    const due = (await tx.commercialChangeRequest.findMany({ where: { tenant_id, product_key, state: 'PENDING_APPROVAL', expires_at: { lte: now } } })) as CommercialChangeRequestRow[];
    for (const r of due) {
      await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, r.id);
      await this.expireIfDue(tx, r, now, ctx);
    }
  }

  private async appendEvent(
    tx: Tx,
    actor: CommercialActor,
    req: CommercialChangeRequestRow,
    event_type: string,
    payload: Record<string, unknown>,
    ctx: CommercialCallContext,
    role_keys?: readonly string[],
  ): Promise<void> {
    const keys = role_keys ?? (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
    await this.audit.append(
      {
        actor: { id: actor.user_id, type: 'user', role_keys: keys },
        event_type,
        tenant_id: req.tenant_id,
        subject: SUBJECT(req.id),
        change_request_id: req.id,
        policy_version_id: req.policy_version_id,
        payload: { action_type: req.action_type, ...payload },
        correlation_id: ctx.correlation_id,
      },
      tx,
    );
  }
}

