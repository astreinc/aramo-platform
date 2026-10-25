import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import {
  type ApprovalRefusal,
  CommercialApplyRefusedError,
  type EligibilityActor,
  type EligibilityResult,
  assertChainStillSatisfiableAtApply,
  checkApprovalEligibility,
  checkChainSatisfiable,
} from './commercial-approval-eligibility.js';
import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_OPEN_STATES,
  COMMERCIAL_ROLE_CHANGE_ACTIONS,
  COMMERCIAL_REQUEST_PRODUCT_KEYS,
  POLICY_TARGET_CHECKSUM_KEY,
  type CommercialActionType,
  type CommercialChangeRequestKind,
  type CommercialChangeRequestState,
  type CommercialRequiredChain,
  isA6Applicable,
  isA7Applicable,
  isCatalogApplicable,
  parseRequiredChain,
  payloadChecksum,
  resolveRequiredChain,
  subjectUserOf,
  validatePayload,
} from './commercial-change-request.js';
import { approvalExpiresAt } from './commercial-policy-boundaries.js';
import { canonicalJson } from './commercial-policy.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';
import { CommercialOperatorRepository, D9_STATEMENT_VERSION, type LiveOperator } from './commercial-operator.repository.js';
import { POLICY_LOCK_SQL, PolicyActivationRefusedError, activatePolicyVersionInTx } from './commercial-policy-activation.js';
import {
  PLATFORM_OWNER_ROLE_KEY,
  RoleChangeApplyError,
  effectivePlatformOwners,
  grantPlatformRole,
  isPlatformLastOwnerViolation,
  readPlatformSubject,
  revokePlatformRole,
} from './commercial-role-change.js';

// CCP-A3 (PBD §5.1 row A3) — the change-request and approval service. Every write runs in
// ONE subscription transaction that locks the request row (`SELECT … FOR UPDATE`), reads
// the actor's roles, scopes and D9 attestation LIVE (NC-4), decides with the pure engine
// (commercial-approval-eligibility.ts) and appends a CommercialAuditEvent for every
// request and approval act — including refused approval attempts, whose audit row is the
// only thing such a transaction writes.
//
// A3 applies nothing (A6). No domain data mutates. `assertApplyEligible` is the NC-5
// apply-time re-check A6 calls inside its own transaction; it is read-only.
//
// CCP-A9 (PBD §5.1 row A9; TD-A3-5; Q2): governance requests (POLICY_ACTIVATE by a
// finance_admin; ROLE_GRANT / ROLE_REVOKE by a platform_owner, approved by a DIFFERENT
// platform_owner) can now be created; the requester's role and D9 attestation are read live
// in the create transaction. A governed role change is APPLIED by `applyRoleChange` in its
// own transaction right after the approval that completes the chain commits — the narrow A9
// apply path (TD-A9-1): the NC-5 apply-time re-check, then the identity write, then
// APPROVED → APPLYING → APPLIED. A refused apply rolls back, leaves the request APPROVED with
// its signatures untouched and records one COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED event.
//
// CCP-B5 (TD-A9-16): an approval that completes a POLICY_ACTIVATE chain is followed, in its
// own transaction, by `applyPolicyActivation` — the NC-5 signature re-check, the NC-5
// SNAPSHOT re-check (commercial-policy-activation.ts) and the policy write. The guard admits
// no transition out of APPROVED for POLICY_ACTIVATE and B5 does not replace it (A6 owns that
// function), so the request row stays APPROVED and its applied state is the
// COMMERCIAL_CHANGE_REQUEST_APPLIED audit event, surfaced as `effect_applied_at`
// (pre-execution C-1; TD-B5-1).

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
  | 'REQUESTER_ROLE_MISSING'
  | 'LAST_OWNER'
  | 'KIND_NOT_SUPPORTED'
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'STATE_INVALID'
  | 'OPEN_REQUEST_EXISTS'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'INTEGRITY'
  // CCP-A6 — apply was asked for an action type A6 does not apply.
  | 'ACTION_NOT_APPLICABLE'
  // CCP-A6-R (TD-A6-3) — the requester no longer holds the requester scope at apply time.
  | 'REQUESTER_NO_LONGER_AUTHORIZED'
  // CCP-A6-R (Charter Amendment A1, AD-7) — the apply authority has expired.
  | 'APPLY_EXPIRED';

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
  /**
   * CCP-B5 — when the request's effect was applied: `applied_at` for a request that reached
   * APPLIED, else the time of its COMMERCIAL_CHANGE_REQUEST_APPLIED event (a POLICY_ACTIVATE
   * stays APPROVED, pre-execution C-1); null when nothing was applied. Read-only, derived.
   */
  effect_applied_at?: Date | null;
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

/** CCP-A9: the outcome of the role-change apply that follows the completing approval. */
export interface RoleChangeApplyOutcome {
  applied: boolean;
  request: CommercialChangeRequestRow;
  /** null when applied; else the refusal reason (the request stays APPROVED). */
  reason: string | null;
  detail: Record<string, unknown>;
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
  /**
   * CCP-A6-R (TD-B2-3 narrows TD-A6-3: apply is REQUESTER-ONLY in v1) — whether the CALLER may
   * apply this request now: the caller is its requester (a person holding the requester scope),
   * the request is APPROVED or APPLY_FAILED, and its action is applied by the governed apply. A UI
   * hint only: the apply re-checks every condition in its own transaction.
   */
  apply_actionable: boolean;
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

/** CCP-A9: the typed reason of a refused role-change apply. */
function classifyApplyRefusal(e: unknown): { reason: string; detail: Record<string, unknown> } {
  if (e instanceof CommercialApplyRefusedError) return { reason: e.reason, detail: e.detail };
  if (e instanceof PolicyActivationRefusedError) return { reason: e.reason, detail: e.detail };
  if (e instanceof RoleChangeApplyError) return { reason: e.reason, detail: e.detail };
  if (e instanceof CommercialChangeRequestError) return { reason: e.code, detail: e.details };
  if (isPlatformLastOwnerViolation(e)) return { reason: 'PLATFORM_LAST_OWNER', detail: {} };
  if (isUniqueViolation(e, 'human')) return { reason: 'ATTESTATION_CONFLICT', detail: { reason: 'human_ref_in_use' } };
  return { reason: 'APPLY_ERROR', detail: { message: String((e as Error)?.message ?? e).slice(0, 500) } };
}

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
    if (def.requester_scope === null && def.requester_role === null) {
      throw new CommercialChangeRequestError('REQUESTER_AUTHORITY_UNDEFINED', `no requester authority is defined for ${input.action_type} yet`, { action_type: input.action_type });
    }
    if (def.requester_scope !== null && !actor.scopes.includes(def.requester_scope)) {
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
    const validated = (() => {
      try {
        return validatePayload(input.action_type, input.payload);
      } catch (e) {
        throw new CommercialChangeRequestError('INVALID_INPUT', (e as Error).message, { reason: 'invalid_payload', errors: (e as { errors?: unknown }).errors ?? [] });
      }
    })();
    // CCP-B5 (pre-execution C-3): every POLICY_ACTIVATE carries the NC-5 snapshot of its
    // target's content; filled from the target row when the client omits it (re-verified
    // inside the create transaction, validateGovernanceTarget).
    const payload = input.action_type === 'POLICY_ACTIVATE' ? await this.withPolicyTargetSnapshot(validated) : validated;
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
        const requester = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id, def.requester_role !== null);
        if (def.requester_role !== null) {
          // CCP-A9 (TD-A3-5): live role + D9 attestation (A1-3: the requester is one of the
          // distinct independent humans of the chain).
          if (!requester.attested) throw new CommercialChangeRequestError('NOT_HUMAN', 'the requester holds no active one-account-per-human attestation', { reason: 'not_human' });
          if (!requester.role_keys.includes(def.requester_role)) {
            throw new CommercialChangeRequestError('REQUESTER_ROLE_MISSING', `requesting ${input.action_type} requires the ${def.requester_role} role`, { required_role: def.requester_role });
          }
          await this.validateGovernanceTarget(tx, input.action_type, payload, ctx);
        }
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
  async approve(
    actor: CommercialActor,
    id: string,
    input: { step_index: number; comment?: string | null },
    ctx: CommercialCallContext,
  ): Promise<{ request: CommercialChangeRequestRow; approval: CommercialApprovalRow; apply: RoleChangeApplyOutcome | null }> {
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
    // CCP-A9: a completed role change applies in its own transaction (TD-A9-1).
    if (out.request.state === 'APPROVED' && (COMMERCIAL_ROLE_CHANGE_ACTIONS as readonly string[]).includes(out.request.action_type)) {
      const apply = await this.applyRoleChange(actor, id, ctx);
      return { request: apply.request, approval: out.approval, apply };
    }
    // CCP-B5 (TD-A9-16): a completed policy activation applies in its own transaction.
    if (out.request.state === 'APPROVED' && out.request.action_type === 'POLICY_ACTIVATE') {
      const apply = await this.applyPolicyActivation(actor, id, ctx);
      return { request: apply.request, approval: out.approval, apply };
    }
    return { request: out.request, approval: out.approval, apply: null };
  }

  // ---- CCP-A9 role-change apply (narrow apply path, TD-A9-1) ----------------------------

  /**
   * Applies an APPROVED ROLE_GRANT / ROLE_REVOKE in ONE transaction: lock the request,
   * integrity, the NC-5 apply-time re-check of every signature against the snapshotted
   * chain and the live roster, APPROVED → APPLYING, the identity write (the last-owner
   * trigger is the DB authority for a removal), the D9 attestation of a not-yet-attested
   * grant subject, APPLYING → APPLIED, and the audit event. Any refusal rolls the whole
   * transaction back: the request stays APPROVED, the approval rows are untouched, and one
   * COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED event is written in a separate transaction.
   */
  async applyRoleChange(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<RoleChangeApplyOutcome> {
    try {
      const row = await this.tx(async (tx) => {
        const req = await this.lock(tx, id);
        this.verifyIntegrity(req);
        if (!(COMMERCIAL_ROLE_CHANGE_ACTIONS as readonly string[]).includes(req.action_type)) {
          throw new CommercialChangeRequestError('STATE_INVALID', `${req.action_type} is not applied by the role-change path`, { action_type: req.action_type });
        }
        const approvals = await this.approvalsOf(tx, id);
        const roster = await this.operators.readRoster(tx, ctx.platform_tenant_id, { user_ids: approvals.map((a) => a.approver_user_id), lock: true });
        const p = req.payload as { subject_user_id: string; role_key: string; human_ref_hash?: string };
        assertChainStillSatisfiableAtApply(
          { id, state: req.state, requested_by: req.requested_by, subject_user_id: p.subject_user_id, required_chain: parseRequiredChain(req.required_chain), approvals },
          roster,
        );
        const now = this.now();
        await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLYING', apply_attempts: { increment: 1 }, updated_at: now } });
        const change =
          req.action_type === 'ROLE_GRANT'
            ? await grantPlatformRole(tx, ctx.platform_tenant_id, { user_id: p.subject_user_id, role_key: p.role_key })
            : await revokePlatformRole(tx, ctx.platform_tenant_id, { user_id: p.subject_user_id, role_key: p.role_key });
        let attestation_id: string | null = null;
        if (req.action_type === 'ROLE_GRANT') {
          const existing = await tx.commercialOperatorAttestation.findFirst({ where: { user_id: p.subject_user_id, revoked_at: null }, select: { id: true } });
          if (existing === null) {
            if (p.human_ref_hash === undefined) throw new RoleChangeApplyError('ATTESTATION_CONFLICT', { reason: 'human_ref_missing' });
            // D9 (TD-A3-3 closed): attested by the distinct platform_owner who signed the grant.
            const attester = approvals[approvals.length - 1]?.approver_user_id as string;
            const a = await tx.commercialOperatorAttestation.create({
              data: { id: uuidv7(), user_id: p.subject_user_id, human_ref_hash: p.human_ref_hash, statement_version: D9_STATEMENT_VERSION, method: 'PLATFORM_OWNER', attested_by: attester, attested_at: now },
            });
            attestation_id = a.id;
            await this.audit.append(
              {
                actor: { id: attester, type: 'user', role_keys: roster.find((r) => r.user_id === attester)?.role_keys ?? [] },
                event_type: 'COMMERCIAL_OPERATOR_ATTESTATION_RECORDED',
                subject: `commercial_operator_attestation:${a.id}`,
                change_request_id: id,
                policy_version_id: req.policy_version_id,
                payload: { user_id: p.subject_user_id, method: 'PLATFORM_OWNER', statement_version: D9_STATEMENT_VERSION },
                correlation_id: ctx.correlation_id,
              },
              tx,
            );
          }
        }
        const done = (await tx.commercialChangeRequest.update({ where: { id }, data: { state: 'APPLIED', applied_at: now, updated_at: now } })) as CommercialChangeRequestRow;
        await this.appendEvent(
          tx,
          actor,
          req,
          'COMMERCIAL_CHANGE_REQUEST_APPLIED',
          { change: req.action_type === 'ROLE_GRANT' ? 'GRANT' : 'REVOKE', subject_user_id: p.subject_user_id, role_key: p.role_key, membership_role_id: change.membership_role_id, attestation_id },
          ctx,
        );
        return done;
      });
      return { applied: true, request: row, reason: null, detail: {} };
    } catch (e) {
      const { reason, detail } = classifyApplyRefusal(e);
      const req = await this.tx(async (tx) => {
        const current = await this.lock(tx, id);
        await this.appendEvent(tx, actor, current, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED', { reason, detail }, ctx);
        return current;
      });
      return { applied: false, request: req, reason, detail };
    }
  }

  // ---- CCP-B5 POLICY_ACTIVATE apply (TD-A9-16; pre-execution C-1, C-2) ------------------

  /**
   * Applies an APPROVED POLICY_ACTIVATE in ONE transaction: lock the request, integrity,
   * idempotency (an existing COMMERCIAL_CHANGE_REQUEST_APPLIED event → no-op), the NC-5
   * re-check of every signature against the snapshotted chain and the live roster, then the
   * NC-5 snapshot re-check and the policy write (activatePolicyVersionInTx) and the audit
   * rows. The request row is NOT written (the guard admits no transition out of APPROVED for
   * POLICY_ACTIVATE): it stays APPROVED with its approval rows untouched, success or refusal.
   * A refusal rolls the transaction back and records one COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED
   * event in a separate transaction.
   */
  async applyPolicyActivation(actor: CommercialActor, id: string, ctx: CommercialCallContext): Promise<RoleChangeApplyOutcome> {
    try {
      const out = await this.tx(async (tx) => {
        const req = await this.lock(tx, id);
        this.verifyIntegrity(req);
        if (req.action_type !== 'POLICY_ACTIVATE') {
          throw new CommercialChangeRequestError('STATE_INVALID', `${req.action_type} is not applied by the policy activation path`, { action_type: req.action_type });
        }
        const prior = await tx.commercialAuditEvent.findFirst({ where: { change_request_id: id, event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED' }, select: { id: true } });
        if (prior !== null) return { req, already: true as const, detail: { applied_event_id: prior.id } };
        const approvals = await this.approvalsOf(tx, id);
        const roster = await this.operators.readRoster(tx, ctx.platform_tenant_id, { user_ids: approvals.map((a) => a.approver_user_id), lock: true });
        assertChainStillSatisfiableAtApply(
          { id, state: req.state, requested_by: req.requested_by, subject_user_id: null, required_chain: parseRequiredChain(req.required_chain), approvals },
          roster,
        );
        const now = this.now();
        const r = await activatePolicyVersionInTx(tx, { policy_version_id: req.policy_version_id, policy_checksum: req.policy_checksum, payload: req.payload }, { activated_by: actor.user_id, at: now, change_request_id: id });
        const keys = (await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id)).role_keys;
        await this.audit.append(
          {
            actor: { id: actor.user_id, type: 'user', role_keys: keys },
            event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED',
            subject: `commercial_policy_version:${r.to_version_id}`,
            change_request_id: id,
            policy_version_id: r.to_version_id,
            payload: { version_number: r.to_version_number, content_checksum: r.to_content_checksum, replaces: r.from_version_id, replaces_version_number: r.from_version_number, rollback: r.to_previous_status === 'RETIRED' },
            correlation_id: ctx.correlation_id,
          },
          tx,
        );
        const detail = { change: 'POLICY_ACTIVATE', from_version_id: r.from_version_id, from_version_number: r.from_version_number, to_version_id: r.to_version_id, to_version_number: r.to_version_number, rollback: r.to_previous_status === 'RETIRED' };
        await this.appendEvent(tx, actor, req, 'COMMERCIAL_CHANGE_REQUEST_APPLIED', detail, ctx, keys);
        return { req, already: false as const, detail };
      });
      return { applied: true, request: { ...out.req, effect_applied_at: await this.effectAppliedAt(out.req) }, reason: null, detail: out.already ? { ...out.detail, replayed: true } : out.detail };
    } catch (e) {
      const { reason, detail } = classifyApplyRefusal(e);
      const req = await this.tx(async (tx) => {
        const current = await this.lock(tx, id);
        await this.appendEvent(tx, actor, current, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED', { reason, detail }, ctx);
        return current;
      });
      return { applied: false, request: { ...req, effect_applied_at: null }, reason, detail };
    }
  }

  /** CCP-B5: fills the NC-5 target snapshot of a POLICY_ACTIVATE payload when it is absent. */
  private async withPolicyTargetSnapshot(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload[POLICY_TARGET_CHECKSUM_KEY] !== undefined) return payload;
    const row = await this.prisma.commercialPolicyVersion.findUnique({ where: { id: payload['policy_version_id'] as string }, select: { content_checksum: true } });
    return row === null ? payload : { ...payload, [POLICY_TARGET_CHECKSUM_KEY]: row.content_checksum };
  }

  /** CCP-B5: `effect_applied_at` for one request (see CommercialChangeRequestRow). */
  private async effectAppliedAt(r: CommercialChangeRequestRow): Promise<Date | null> {
    return (await this.effectsOf([r])).get(r.id) ?? null;
  }

  /** CCP-B5: `effect_applied_at` for a page of requests — one audit read for the page. */
  private async effectsOf(rows: readonly CommercialChangeRequestRow[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const r of rows) if (r.applied_at !== null && r.applied_at !== undefined) out.set(r.id, r.applied_at);
    const pending = rows.filter((r) => !out.has(r.id) && r.state === 'APPROVED').map((r) => r.id);
    if (pending.length === 0) return out;
    const events = await this.prisma.commercialAuditEvent.findMany({
      where: { change_request_id: { in: pending }, event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED' },
      select: { change_request_id: true, created_at: true },
    });
    for (const e of events) if (e.change_request_id !== null) out.set(e.change_request_id, e.created_at);
    return out;
  }

  private async withEffects(rows: CommercialChangeRequestRow[]): Promise<CommercialChangeRequestRow[]> {
    const fx = await this.effectsOf(rows);
    return rows.map((r) => ({ ...r, effect_applied_at: fx.get(r.id) ?? null }));
  }

  /** CCP-A9: the target checks of a governance request, inside the create transaction. */
  private async validateGovernanceTarget(tx: Tx, action_type: CommercialActionType, payload: Record<string, unknown>, ctx: CommercialCallContext): Promise<void> {
    const invalid = (reason: string, message: string, extra: Record<string, unknown> = {}): never => {
      throw new CommercialChangeRequestError('INVALID_INPUT', message, { reason, ...extra });
    };
    if (action_type === 'POLICY_ACTIVATE') {
      // CCP-B5: serialised with draft edits and other activation requests (one policy lock).
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const rows = await tx.$queryRawUnsafe<Array<{ status: string; content_checksum: string }>>(
        `SELECT status, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1::uuid`,
        payload['policy_version_id'],
      );
      const status = rows[0]?.status;
      if (status === undefined) invalid('policy_version_not_found', 'the policy version does not exist');
      if (status === 'ACTIVE') invalid('policy_version_already_active', 'the policy version is already ACTIVE');
      // CCP-B5 (pre-execution C-3): the snapshot must be the target's content right now.
      if (rows[0]?.content_checksum !== payload[POLICY_TARGET_CHECKSUM_KEY]) {
        invalid('policy_version_changed', 'the policy version changed after it was read; review it again', { current_checksum: rows[0]?.content_checksum ?? null });
      }
      // Handoff §5.6: only one policy request open at a time (DRAFT or PENDING_APPROVAL).
      const open = await tx.commercialChangeRequest.findFirst({ where: { action_type: 'POLICY_ACTIVATE', state: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, select: { id: true, state: true } });
      if (open !== null) {
        throw new CommercialChangeRequestError('OPEN_REQUEST_EXISTS', 'a policy activation request is already open', { open_request_id: open.id, open_state: open.state, reason: 'open_policy_request_exists' });
      }
      return;
    }
    const subject_user_id = payload['subject_user_id'] as string;
    const role_key = payload['role_key'] as string;
    const subject = await readPlatformSubject(tx, ctx.platform_tenant_id, subject_user_id, true);
    if (!subject.is_platform_member) invalid('subject_not_platform_member', 'the subject is not an active platform administrator (a new admin arrives only through the invite)');
    if (action_type === 'ROLE_GRANT') {
      if (subject.role_keys.includes(role_key)) invalid('role_already_held', `the subject already holds ${role_key}`);
      const ref = payload['human_ref_hash'] as string | undefined;
      if (subject.attestation_id === null && ref === undefined) invalid('human_ref_required', 'the subject has no D9 attestation; human_ref_hash is required');
      if (subject.attestation_id !== null && ref !== undefined) invalid('subject_already_attested', 'the subject is already attested; omit human_ref_hash');
      if (ref !== undefined) {
        const used = await tx.commercialOperatorAttestation.findFirst({ where: { human_ref_hash: ref, revoked_at: null }, select: { id: true } });
        if (used !== null) invalid('human_ref_in_use', 'the human reference is attested for another account (D9)');
      }
      return;
    }
    if (!subject.role_keys.includes(role_key)) invalid('role_not_held', `the subject does not hold ${role_key}`);
    if (role_key === PLATFORM_OWNER_ROLE_KEY) {
      const others = (await effectivePlatformOwners(tx, ctx.platform_tenant_id)).filter((u) => u !== subject_user_id);
      if (others.length === 0) throw new CommercialChangeRequestError('LAST_OWNER', 'the platform must keep at least one active platform_owner', { reason: 'platform_last_owner' });
    }
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
    const found = (await this.prisma.commercialChangeRequest.findUnique({ where: { id } })) as CommercialChangeRequestRow | null;
    if (found === null) throw new CommercialChangeRequestError('NOT_FOUND', 'change request not found', { id });
    // Charter Amendment A1 (AD-7) — a read evaluates the apply deadline lazily.
    const req = await this.lazyExpireApply(found, ctx);
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
    const [enriched] = await this.withEffects([req]);
    return { request: enriched ?? req, approvals, chain, is_expired, steps: this.stepViews(actor, live, req, chain, approvals, now), chain_satisfiable: satisfiable, apply_actionable: applyActionable(actor, req) };
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
      return { requests: await this.withEffects(out), next_cursor: null };
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
    // Charter Amendment A1 (AD-7) — the listed rows evaluate the apply deadline lazily.
    const page = await Promise.all(rows.slice(0, limit).map((r) => this.lazyExpireApply(r, ctx)));
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last !== undefined ? Buffer.from(JSON.stringify({ v: 1, c: last.created_at.toISOString(), i: last.id, fp }), 'utf8').toString('base64url') : null;
    return { requests: await this.withEffects(page), next_cursor };
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

  /** Lazily expires the due PENDING requests of a tenant × product (CCP-A8 calls it in its own create transaction). */
  async expireOpenFor(tx: Tx, tenant_id: string, product_key: string, now: Date, ctx: CommercialCallContext): Promise<void> {
    const due = (await tx.commercialChangeRequest.findMany({ where: { tenant_id, product_key, state: 'PENDING_APPROVAL', expires_at: { lte: now } } })) as CommercialChangeRequestRow[];
    for (const r of due) {
      await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, r.id);
      await this.expireIfDue(tx, r, now, ctx);
    }
    // Charter Amendment A1 (AD-5, AD-7) — a create contending for the slot expires an approved
    // request whose apply authority has lapsed, releasing the slot.
    const approved = (await tx.commercialChangeRequest.findMany({ where: { tenant_id, product_key, state: { in: ['APPROVED', 'APPLY_FAILED'] } } })) as CommercialChangeRequestRow[];
    for (const r of approved) {
      await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, r.id);
      const current = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: r.id } })) as CommercialChangeRequestRow;
      try {
        await this.expireApplyIfDue(tx, current, now, ctx);
      } catch (e) {
        // A malformed snapshot never expires a request silently; the apply fails closed on it.
        if (!(e instanceof CommercialChangeRequestError)) throw e;
      }
    }
  }

  // ---- apply deadline (Charter Amendment A1, LOCKED 2026-10-25) ----------------------------

  /**
   * AD-2 / AD-3 — the apply deadline of an approved request: `approved_at` (the final approval) +
   * `apply_expiry_hours` of the policy version the request SNAPSHOTTED (never the ACTIVE one). A
   * version without the key (v1) gives no deadline (null). The window is half-open: authority
   * exists while `now < deadline`. A snapshot that cannot be read or verified fails closed
   * (INTEGRITY).
   */
  async applyDeadlineOf(req: CommercialChangeRequestRow, client: Pick<PrismaService, 'commercialPolicyVersion'> = this.prisma): Promise<Date | null> {
    if (req.approved_at === null) return null;
    let hours: number | undefined;
    try {
      const policy = await this.policies.getVersionPolicy(req.policy_version_id, client);
      if (policy.checksum !== req.policy_checksum) throw new CommercialChangeRequestError('INTEGRITY', 'policy snapshot checksum mismatch', { reason: 'policy_checksum' });
      hours = policy.content.apply_expiry_hours;
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) throw e;
      throw new CommercialChangeRequestError('INTEGRITY', 'the snapshotted policy version cannot be read', { reason: 'policy_unavailable', error: (e as Error).message });
    }
    return hours === undefined ? null : new Date(req.approved_at.getTime() + hours * 3_600_000);
  }

  /**
   * AD-4 / AD-6 / AD-7 — inside the caller's transaction, AFTER the request row is locked: an
   * APPROVED or APPLY_FAILED request at or past its apply deadline becomes APPLY_EXPIRED (terminal,
   * not open: the Q14 slot is released) with exactly ONE audit event. Never from APPLYING (an apply
   * in progress holds the row lock and moves the request out of APPLYING in its own transaction).
   * Returns true when it expired the request now.
   */
  async expireApplyIfDue(tx: Tx, req: CommercialChangeRequestRow, now: Date, ctx: CommercialCallContext): Promise<boolean> {
    if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') return false;
    // Merge train TD-MERGE-21: only the action types whose DB guard admits APPLY_EXPIRED (the A6 and
    // CCP-B2-backend apply set) expire. Any other APPROVED request (an applied POLICY_ACTIVATE, which
    // stays APPROVED until TD-B5-1 lands; a CONVERSION, refused at its deadline by C2 without a state
    // change) is left alone, so a read never fails on a transition the guard refuses.
    if (!isApplyExpirable(req.action_type)) return false;
    const deadline = await this.applyDeadlineOf(req, tx);
    if (deadline === null || now.getTime() < deadline.getTime()) return false;
    await tx.commercialChangeRequest.update({ where: { id: req.id }, data: { state: 'APPLY_EXPIRED', updated_at: now } });
    await this.audit.append(
      {
        actor: { id: null, type: 'system', role_keys: [] },
        event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED',
        tenant_id: req.tenant_id,
        subject: SUBJECT(req.id),
        change_request_id: req.id,
        policy_version_id: req.policy_version_id,
        payload: {
          action_type: req.action_type,
          from_state: req.state,
          final_approved_at: (req.approved_at as Date).toISOString(),
          apply_deadline: deadline.toISOString(),
          evaluated_at: now.toISOString(),
        },
        correlation_id: ctx.correlation_id,
      },
      tx,
    );
    return true;
  }

  /** AD-7 — the read path: expire lazily (own transaction, row locked); a read never fails on it. */
  private async lazyExpireApply(req: CommercialChangeRequestRow, ctx: CommercialCallContext): Promise<CommercialChangeRequestRow> {
    if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') return req;
    if (!isApplyExpirable(req.action_type)) return req;
    try {
      const deadline = await this.applyDeadlineOf(req);
      if (deadline === null || this.now().getTime() < deadline.getTime()) return req;
      return await this.tx(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, req.id);
        const current = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: req.id } })) as CommercialChangeRequestRow;
        await this.expireApplyIfDue(tx, current, this.now(), ctx);
        return (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: req.id } })) as CommercialChangeRequestRow;
      });
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) return req;
      throw e;
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

/** CCP-A6-R — the caller-side apply hint (requester-only in v1; TD-B2-3). */
export function applyActionable(actor: CommercialActor, req: Pick<CommercialChangeRequestRow, 'action_type' | 'state' | 'requested_by'>): boolean {
  if (actor.actor_kind !== 'user' || actor.user_id !== req.requested_by) return false;
  if (req.state !== 'APPROVED' && req.state !== 'APPLY_FAILED') return false;
  // Merge train TD-MERGE-26 / -30: the CCP-A7 revoke and the CCP-A8 NORMAL support extension are
  // applied by the same route (requester-only; a bounded EXCEPTION is APPLIED at creation).
  // CCP-B3 (pre-execution C-2; TD-B3) — the CCP-C2 conversion apply (`…/convert`) is requester-only
  // under the same rule, so the hint covers CONVERSION too.
  if (!isA6Applicable(req.action_type) && !isCatalogApplicable(req.action_type) && !isA7Applicable(req.action_type) && req.action_type !== 'SUPPORT_EXTENSION' && req.action_type !== 'CONVERSION') return false;
  const scope = COMMERCIAL_ACTIONS[req.action_type as CommercialActionType].requester_scope;
  return scope !== null && actor.scopes.includes(scope);
}

/** TD-MERGE-21 — the action types whose DB guard admits → APPLY_EXPIRED (A6-R: the A6 + CCP-B2-backend apply set). */
function isApplyExpirable(action_type: string): boolean {
  return isA6Applicable(action_type) || isCatalogApplicable(action_type);
}
