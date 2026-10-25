import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { Prisma } from '../../../prisma/generated/client/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertProductKey, type ProductKey } from '../product-registry.js';
import { REFUND_POLICY_NOT_APPROVED, refundExecutionEnabled } from '../commercial/commercial-billing-adjustment.js';
import { canonicalJson } from '../commercial/commercial-policy.js';

import {
  BILLING_PROVIDER_ADJUSTMENT_PORT,
  BILLING_PROVIDER_COMMAND_PORT,
  BILLING_PROVIDER_PORT,
  type BillingProviderAdjustmentPort,
  type BillingProviderCommandPort,
  type BillingProviderPort,
  BillingProviderUnavailableError,
} from './billing-provider.port.js';
import {
  type AdjustmentCommandParams,
  BILLING_COMMAND_ACTIONS,
  BILLING_COMMAND_KINDS_BY_ACTION,
  BILLING_COMMAND_KINDS,
  BILLING_COMMAND_LEASE_MS,
  BILLING_COMMAND_MAX_ATTEMPTS,
  BILLING_COMMAND_REQUEST_STATES,
  BILLING_COMMAND_STATES,
  BILLING_COMMAND_STEP,
  type BillingCommandKind,
  type BillingCommandState,
  REFETCH_CONFIRMATION,
  type SubscriptionCancelMode,
  billingCommandBackoffMs,
  adjustmentParamErrors,
  adjustmentRequestOf,
  billingCommandIdempotencyKey,
  cancelModeOf,
  isAdjustmentCommandKind,
  subscriptionCancelConfirmed,
} from './billing-provider-command.js';
import { takeBillingLock } from './governed-subscription.js';
import { type ApplyResult, SubscriptionLifecycleService, mapProviderStatus } from './subscription-lifecycle.service.js';

// CCP-C1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C1; Conversion Rule C-22, C-23;
// Charter §1.3, §3) — the Stripe command outbox.
//
//   enqueue    a local INSERT (optionally inside the caller's transaction: the outbox). Keyed by
//              (change request, step); the idempotency key is derived from both (C-22). Only a
//              request that completed its approval chain, of a command-issuing action, for the
//              same tenant and product, against a target that tenant owns.
//   dispatch   claim (ONE autocommit statement, SKIP LOCKED, with a lease) → the provider call
//              with NO local transaction open → record the outcome with a fenced UPDATE.
//              Accepted → PENDING_PROVIDER. Transient failure → RETRY_WAIT (backoff) until
//              BILLING_COMMAND_MAX_ATTEMPTS, then FAILED. Provider refusal → FAILED. FAILED is
//              surfaced (GET /platform/commercial/billing-commands) and retryable (retryFailed);
//              a command is never dropped (DELETE rejected at the DB).
//   confirm    never here: CONFIRMED is written by the transaction that APPLIES the provider-
//              confirmed state (verified webhook through the inbox, or reconcilePending's
//              re-fetch), so the external change is never reported committed on local commit (C-23).
//
// Production hold (PBD §7.3; Conv. C-26): nothing here enables billing. Dispatch does nothing when
// the provider is not configured, and refuses to run against a live-mode key (live Stripe is out
// of C1's scope): commands stay PENDING, visible.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export type BillingCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'CHANGE_REQUEST_NOT_FOUND'
  | 'CHANGE_REQUEST_NOT_APPROVED'
  | 'ACTION_NOT_COMMAND_ISSUING'
  | 'TENANT_PRODUCT_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'NOT_FAILED'
  | 'INVALID_CURSOR';

export class BillingCommandError extends Error {
  constructor(
    public readonly code: BillingCommandErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BillingCommandError';
  }
}

/** A refusal decided before (or instead of) the provider call: never retried automatically. */
class CommandRefusal extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

export interface BillingCommandRow {
  id: string;
  provider: string;
  command_kind: string;
  change_request_id: string;
  step: string;
  idempotency_key: string;
  tenant_id: string;
  product_key: string;
  target_ref: string;
  params: unknown;
  state: string;
  attempts: number;
  lease_until: Date | null;
  next_attempt_at: Date | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  provider_accepted_at: Date | null;
  confirmed_at: Date | null;
  confirmation_source: string | null;
  confirmation_event_id: string | null;
  failed_at: Date | null;
  /** CCP-C4 — the provider object carrying an adjustment's effect (null for C1 kinds). */
  provider_object_ref: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueBillingCommandInput {
  change_request_id: string;
  step: string;
  command_kind: BillingCommandKind;
  tenant_id: string;
  product_key: ProductKey;
  target_ref: string;
  /** SUBSCRIPTION_CANCEL: the cancel mode; CHECKOUT_SESSION_EXPIRE: omitted. */
  mode?: SubscriptionCancelMode;
  /** CCP-C4 adjustment kinds: the closed params of the kind (ADJUSTMENT_PARAM_KEYS). */
  params?: AdjustmentCommandParams;
  created_by: string;
  at: Date;
}

export interface DispatchTally {
  skipped: null | 'NOT_CONFIGURED' | 'LIVE_MODE';
  claimed: number;
  accepted: number;
  retry_wait: number;
  failed: number;
  lost_fence: number;
}

export interface ReconcileTally {
  checked: number;
  confirmed: number;
  failed: number;
  results: ApplyResult[];
}

export interface BillingCommandListQuery {
  state?: BillingCommandState;
  tenant_id?: string;
  change_request_id?: string;
  limit?: number;
  cursor?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeListCursor(row: { created_at: Date; id: string }, filter: string): string {
  return Buffer.from(JSON.stringify({ c: row.created_at.toISOString(), i: row.id, f: filter }), 'utf8').toString('base64url');
}

export function decodeListCursor(cursor: string, filter: string): { created_at: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown; f?: unknown };
    const at = typeof v.c === 'string' ? new Date(v.c) : null;
    if (at === null || Number.isNaN(at.getTime()) || typeof v.i !== 'string' || !UUID.test(v.i)) throw new Error('malformed');
    if (v.f !== filter) throw new BillingCommandError('INVALID_CURSOR', 'cursor filters do not match the current query');
    return { created_at: at, id: v.i };
  } catch (e) {
    if (e instanceof BillingCommandError) throw e;
    throw new BillingCommandError('INVALID_CURSOR', 'malformed cursor');
  }
}

@Injectable()
export class BillingCommandService {
  private readonly log = new Logger(BillingCommandService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Optional() @Inject(BILLING_PROVIDER_COMMAND_PORT) private readonly commands?: BillingProviderCommandPort,
    // CCP-C4 — the Stripe-side billing adjustments. Unbound: an adjustment command is never
    // dispatched (it is FAILED ADJUSTMENTS_NOT_CONFIGURED, with no provider call).
    @Optional() @Inject(BILLING_PROVIDER_ADJUSTMENT_PORT) private readonly adjustments?: BillingProviderAdjustmentPort,
  ) {}

  /**
   * Record one Stripe-owned operation for (change request, step). A local write only: pass the
   * caller's transaction to make it part of that transaction (the outbox). A repeat of the same
   * (change request, step, kind, target, params) returns the existing command (`replayed`).
   */
  async enqueue(input: EnqueueBillingCommandInput, tx?: Tx): Promise<{ command: BillingCommandRow; replayed: boolean }> {
    const product_key = assertProductKey(input.product_key);
    const errors: string[] = [];
    if (!(BILLING_COMMAND_KINDS as readonly string[]).includes(input.command_kind)) errors.push(`command_kind must be one of ${BILLING_COMMAND_KINDS.join(', ')}`);
    if (!BILLING_COMMAND_STEP.test(input.step)) errors.push('step must be a snake_case key (1-63 characters)');
    if (typeof input.target_ref !== 'string' || input.target_ref.length < 1 || input.target_ref.length > 255) errors.push('target_ref must be 1-255 characters');
    if (!UUID.test(input.change_request_id)) errors.push('change_request_id must be a uuid');
    if (!UUID.test(input.tenant_id)) errors.push('tenant_id must be a uuid');
    if (input.command_kind === 'SUBSCRIPTION_CANCEL' && cancelModeOf({ mode: input.mode }) === null) errors.push('mode must be IMMEDIATE or AT_PERIOD_END');
    if (input.command_kind === 'CHECKOUT_SESSION_EXPIRE' && input.mode !== undefined) errors.push('a CHECKOUT_SESSION_EXPIRE command takes no mode');
    if (isAdjustmentCommandKind(input.command_kind)) {
      if (input.mode !== undefined) errors.push(`a ${input.command_kind} command takes no mode`);
      errors.push(...adjustmentParamErrors(input.command_kind, input.params));
    } else if (input.params !== undefined) errors.push(`a ${input.command_kind} command takes no adjustment params`);
    if (errors.length > 0) throw new BillingCommandError('INVALID_COMMAND', errors.join('; '), { errors });
    const params: Record<string, unknown> =
      input.command_kind === 'SUBSCRIPTION_CANCEL' ? { mode: input.mode as string } : isAdjustmentCommandKind(input.command_kind) ? { ...(input.params as Record<string, unknown>) } : {};

    const run = async (t: Tx) => {
      // Serialize with the webhook application and the governed apply for this tenant.
      await takeBillingLock(t, input.tenant_id);
      const request = await t.commercialChangeRequest.findUnique({
        where: { id: input.change_request_id },
        select: { id: true, action_type: true, state: true, tenant_id: true, product_key: true },
      });
      if (request === null) throw new BillingCommandError('CHANGE_REQUEST_NOT_FOUND', 'change request not found', { change_request_id: input.change_request_id });
      if (!BILLING_COMMAND_REQUEST_STATES.includes(request.state)) {
        throw new BillingCommandError('CHANGE_REQUEST_NOT_APPROVED', `the change request is ${request.state}; a provider command needs a completed approval chain`, { state: request.state });
      }
      if (!BILLING_COMMAND_ACTIONS.includes(request.action_type)) {
        throw new BillingCommandError('ACTION_NOT_COMMAND_ISSUING', `${request.action_type} does not issue provider commands`, { action_type: request.action_type });
      }
      // CCP-C4 — each command-issuing action issues only its own kinds (DB trigger mirror).
      if (!(BILLING_COMMAND_KINDS_BY_ACTION[request.action_type] ?? []).includes(input.command_kind)) {
        throw new BillingCommandError('ACTION_NOT_COMMAND_ISSUING', `${request.action_type} does not issue ${input.command_kind} commands`, { action_type: request.action_type, command_kind: input.command_kind });
      }
      if (request.tenant_id !== input.tenant_id || request.product_key !== product_key) {
        throw new BillingCommandError('TENANT_PRODUCT_MISMATCH', 'the command names another tenant or product than its change request');
      }
      const existing = await t.billingProviderCommand.findUnique({ where: { change_request_id_step: { change_request_id: input.change_request_id, step: input.step } } });
      if (existing !== null) {
        // canonical JSON: the stored jsonb does not keep the key order (CCP-C4 params carry several keys).
        const same = existing.command_kind === input.command_kind && existing.target_ref === input.target_ref && canonicalJson(existing.params) === canonicalJson(params);
        if (!same) throw new BillingCommandError('IDEMPOTENCY_CONFLICT', 'this change request step already holds a different command', { command_id: existing.id });
        return { command: existing as BillingCommandRow, replayed: true };
      }
      await this.assertTargetOwned(t, input.command_kind, input.tenant_id, product_key, input.target_ref, params);
      const command = await t.billingProviderCommand.create({
        data: {
          id: uuidv7(),
          provider: this.billing.provider,
          command_kind: input.command_kind,
          change_request_id: input.change_request_id,
          step: input.step,
          idempotency_key: billingCommandIdempotencyKey(input.change_request_id, input.step),
          tenant_id: input.tenant_id,
          product_key,
          target_ref: input.target_ref,
          params: params as Prisma.InputJsonValue,
          state: 'PENDING',
          attempts: 0,
          created_by: input.created_by,
          created_at: input.at,
          updated_at: input.at,
        },
      });
      return { command: command as BillingCommandRow, replayed: false };
    };
    return tx !== undefined ? run(tx) : this.prisma.$transaction(run);
  }

  /** The target must be a provider object of THIS tenant and product (never another tenant's). */
  private async assertTargetOwned(t: Tx, kind: BillingCommandKind, tenant_id: string, product_key: ProductKey, target_ref: string, params: Record<string, unknown> = {}): Promise<void> {
    const provider = this.billing.provider;
    if (isAdjustmentCommandKind(kind)) {
      // CCP-C4 — the tenant's OPEN self-service (Stripe-owned) row of this product, and the target is
      // its provider account (credits), its provider subscription (discounts), or an invoice paid
      // from its provider account (refunds; the invoice itself is re-verified at the provider before
      // any refund call). A governed (MANUAL) row is never a target.
      const row = await t.tenantSubscription.findFirst({
        where: { id: String(params['subscription_id'] ?? ''), tenant_id, product_key, billing_provider: provider, source: 'SELF_SERVICE', ended_at: null },
        select: { id: true, billing_account_ref: true, billing_subscription_ref: true },
      });
      const ok =
        row !== null &&
        (kind === 'CREDIT_GRANT' || kind === 'CREDIT_REVERSE'
          ? row.billing_account_ref === target_ref
          : kind === 'REFUND_CREATE'
            ? row.billing_account_ref !== null && row.billing_account_ref === params['account_ref']
            : row.billing_subscription_ref === target_ref);
      if (!ok) throw new BillingCommandError('TARGET_NOT_FOUND', 'no open self-service subscription of this tenant and product owns this provider reference');
      return;
    }
    if (kind === 'SUBSCRIPTION_CANCEL') {
      // An open Stripe-owned (SELF_SERVICE) row, or a held activation (an open reconciliation
      // flag: the provider subscription exists, no Aramo row was opened; Conv. C-7, C-8).
      const row = await t.tenantSubscription.findFirst({
        where: { tenant_id, product_key, billing_provider: provider, billing_subscription_ref: target_ref, source: 'SELF_SERVICE', ended_at: null },
        select: { id: true },
      });
      if (row !== null) return;
      const held = await t.billingReconciliationFlag.findFirst({ where: { tenant_id, provider, subscription_ref: target_ref, resolved_at: null }, select: { id: true } });
      if (held !== null) return;
      throw new BillingCommandError('TARGET_NOT_FOUND', 'no open self-service subscription or held activation of this tenant and product has this provider reference');
    }
    const intent = await t.checkoutIntent.findFirst({
      where: { tenant_id, provider, provider_session_ref: target_ref, status: 'CREATED', plan: { product_key } },
      select: { id: true },
    });
    if (intent === null) throw new BillingCommandError('TARGET_NOT_FOUND', 'no open checkout of this tenant and product has this provider session');
  }

  /** The commands of one change request (C2 reads the pending-provider state from here). */
  async forChangeRequest(change_request_id: string): Promise<BillingCommandRow[]> {
    return (await this.prisma.billingProviderCommand.findMany({ where: { change_request_id }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] })) as BillingCommandRow[];
  }

  /** Operator read (GET /platform/commercial/billing-commands): newest first, keyset cursor. */
  async list(q: BillingCommandListQuery): Promise<{ commands: BillingCommandRow[]; next_cursor: string | null }> {
    if (q.state !== undefined && !(BILLING_COMMAND_STATES as readonly string[]).includes(q.state)) throw new BillingCommandError('INVALID_COMMAND', 'unknown state');
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const filter = JSON.stringify([q.state ?? null, q.tenant_id ?? null, q.change_request_id ?? null]);
    const after = q.cursor === undefined ? null : decodeListCursor(q.cursor, filter);
    const where: Prisma.BillingProviderCommandWhereInput = {
      ...(q.state !== undefined ? { state: q.state } : {}),
      ...(q.tenant_id !== undefined ? { tenant_id: q.tenant_id } : {}),
      ...(q.change_request_id !== undefined ? { change_request_id: q.change_request_id } : {}),
      ...(after !== null ? { OR: [{ created_at: { lt: after.created_at } }, { created_at: after.created_at, id: { lt: after.id } }] } : {}),
    };
    const rows = (await this.prisma.billingProviderCommand.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 })) as BillingCommandRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { commands: page, next_cursor: rows.length > limit && last !== undefined ? encodeListCursor(last, filter) : null };
  }

  /** Explicit retry of a FAILED command (FAILED → PENDING; the attempt count is kept). */
  async retryFailed(id: string, at: Date): Promise<BillingCommandRow> {
    const r = await this.prisma.billingProviderCommand.updateMany({
      where: { id, state: 'FAILED' },
      data: { state: 'PENDING', next_attempt_at: null, lease_until: null, updated_at: at },
    });
    const row = await this.prisma.billingProviderCommand.findUnique({ where: { id } });
    if (row === null) throw new BillingCommandError('NOT_FOUND', 'command not found');
    if (r.count === 0) throw new BillingCommandError('NOT_FAILED', `the command is ${row.state}`, { state: row.state });
    return row as BillingCommandRow;
  }

  /**
   * Dispatch every due command (up to `limit`). Each provider call runs with no local transaction
   * open: the claim is one autocommit statement and the outcome is a separate fenced statement.
   */
  async dispatchDue(at: Date, limit = 25): Promise<DispatchTally> {
    const tally: DispatchTally = { skipped: null, claimed: 0, accepted: 0, retry_wait: 0, failed: 0, lost_fence: 0 };
    if (this.commands === undefined || !this.commands.isConfigured()) return { ...tally, skipped: 'NOT_CONFIGURED' };
    // Production hold (PBD §7.3) — live Stripe is out of C1's scope; commands stay PENDING.
    // CCP-C4: the adjustment port is held the same way (TD-C1-3; live billing is not authorized).
    if (this.commands.mode() === 'live' || this.adjustments?.mode() === 'live') {
      this.log.warn('billing commands not dispatched: the provider key is live-mode (live Stripe is not authorized)');
      return { ...tally, skipped: 'LIVE_MODE' };
    }
    for (let i = 0; i < limit; i += 1) {
      const cmd = await this.claim(at);
      if (cmd === null) break;
      tally.claimed += 1;
      const outcome = await this.dispatchClaimed(cmd, at);
      tally[outcome] += 1;
    }
    return tally;
  }

  /** One autocommit statement: the oldest due command → DISPATCHING (attempt counted, leased). */
  private async claim(at: Date): Promise<BillingCommandRow | null> {
    const lease = new Date(at.getTime() + BILLING_COMMAND_LEASE_MS);
    const rows = await this.prisma.$queryRaw<BillingCommandRow[]>`
      UPDATE "subscription"."BillingProviderCommand" c
         SET "state" = 'DISPATCHING', "attempts" = c."attempts" + 1, "lease_until" = ${lease}, "updated_at" = ${at}
       WHERE c."id" = (
         SELECT q."id" FROM "subscription"."BillingProviderCommand" q
          WHERE (q."state" IN ('PENDING', 'RETRY_WAIT') AND (q."next_attempt_at" IS NULL OR q."next_attempt_at" <= ${at}))
             OR (q."state" = 'DISPATCHING' AND q."lease_until" <= ${at})
          ORDER BY q."created_at", q."id"
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING c.*`;
    return rows[0] ?? null;
  }

  private async dispatchClaimed(cmd: BillingCommandRow, at: Date): Promise<'accepted' | 'retry_wait' | 'failed' | 'lost_fence'> {
    let next: Prisma.BillingProviderCommandUpdateManyMutationInput;
    let outcome: 'accepted' | 'retry_wait' | 'failed';
    try {
      const done = await this.perform(cmd);
      const detail = typeof done === 'string' ? done : done.detail;
      const object_ref = typeof done === 'string' ? null : done.object_ref;
      next = {
        state: 'PENDING_PROVIDER',
        provider_accepted_at: at,
        lease_until: null,
        next_attempt_at: null,
        last_error_code: null,
        last_error_detail: detail,
        // CCP-C4 — the provider object carrying the effect (recorded once; the webhook names it).
        ...(object_ref !== null && cmd.provider_object_ref === null ? { provider_object_ref: object_ref } : {}),
        updated_at: at,
      };
      outcome = 'accepted';
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      if (e instanceof CommandRefusal) {
        next = { state: 'FAILED', failed_at: at, lease_until: null, last_error_code: e.code, last_error_detail: message, updated_at: at };
        outcome = 'failed';
      } else {
        const retryable = !(e instanceof BillingProviderUnavailableError) || e.retryable;
        const code = e instanceof BillingProviderUnavailableError ? (retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REFUSED') : 'UNEXPECTED';
        if (retryable && cmd.attempts < BILLING_COMMAND_MAX_ATTEMPTS) {
          next = { state: 'RETRY_WAIT', next_attempt_at: new Date(at.getTime() + billingCommandBackoffMs(cmd.attempts)), lease_until: null, last_error_code: code, last_error_detail: message, updated_at: at };
          outcome = 'retry_wait';
        } else {
          next = { state: 'FAILED', failed_at: at, lease_until: null, last_error_code: retryable ? 'RETRIES_EXHAUSTED' : code, last_error_detail: message, updated_at: at };
          outcome = 'failed';
        }
      }
      if (outcome === 'failed') this.log.warn(`billing command ${cmd.id} (${cmd.command_kind} ${cmd.target_ref}) FAILED: ${message}`);
    }
    // Fenced: only the claim that made this attempt records its outcome (a confirmation or a
    // re-claim after an expired lease wins).
    const r = await this.prisma.billingProviderCommand.updateMany({ where: { id: cmd.id, state: 'DISPATCHING', attempts: cmd.attempts }, data: next });
    return r.count === 1 ? outcome : 'lost_fence';
  }

  /** The provider side of one command. Throws CommandRefusal (permanent) or a provider error. */
  private async perform(cmd: BillingCommandRow): Promise<string | { detail: string; object_ref: string | null }> {
    if (isAdjustmentCommandKind(cmd.command_kind)) return this.performAdjustment(cmd);
    const commands = this.commands as BillingProviderCommandPort;
    if (cmd.command_kind === 'SUBSCRIPTION_CANCEL') {
      const mode = cancelModeOf(cmd.params);
      if (mode === null) throw new CommandRefusal('INVALID_PARAMS', 'cancel mode missing');
      // Re-read the provider object first: never act on another tenant's subscription, and do not
      // repeat an operation the provider already shows in effect.
      const state = await this.billing.retrieveSubscription(cmd.target_ref);
      if (state.tenant_id !== null && state.tenant_id !== cmd.tenant_id) throw new CommandRefusal('TENANT_MISMATCH', 'provider metadata tenant does not match the command');
      if (subscriptionCancelConfirmed(cmd.params, state, mapProviderStatus(state.provider_status).ends)) return 'already in effect at the provider';
      await commands.cancelSubscription(cmd.target_ref, { at_period_end: mode === 'AT_PERIOD_END' }, cmd.idempotency_key);
      return `cancel (${mode}) accepted by the provider`;
    }
    if (cmd.command_kind === 'CHECKOUT_SESSION_EXPIRE') {
      const session = await commands.retrieveCheckoutSession(cmd.target_ref);
      if (session.tenant_id !== null && session.tenant_id !== cmd.tenant_id) throw new CommandRefusal('TENANT_MISMATCH', 'provider session tenant does not match the command');
      if (session.status === 'expired') return 'already in effect at the provider';
      if (session.status === 'complete') throw new CommandRefusal('SESSION_COMPLETED', 'the checkout session completed; it can no longer be expired');
      await commands.expireCheckoutSession(cmd.target_ref, cmd.idempotency_key);
      return 'expire accepted by the provider';
    }
    throw new CommandRefusal('UNKNOWN_KIND', `unknown command kind ${cmd.command_kind}`);
  }

  /**
   * CCP-C4 — one billing adjustment. Before any provider call (all outside any transaction):
   *   - REFUND_CREATE while the refund execution path is disabled → FAILED REFUND_POLICY_NOT_APPROVED
   *     (the designed disabled state, PBD §10), never a provider call;
   *   - the change request must be APPLYING (it completed its chain and its requester applied it):
   *     no money movement without a completed chain (PBD C4 HALT row), whatever the queue holds;
   *   - the provider is re-read by the command id: another tenant's object is refused, and an effect
   *     already present is not repeated (no double credit after a lost response or an expired lease).
   * Then the one write, carrying the derived idempotency key.
   */
  private async performAdjustment(cmd: BillingCommandRow): Promise<{ detail: string; object_ref: string | null }> {
    if (this.adjustments === undefined || !this.adjustments.isConfigured()) throw new CommandRefusal('ADJUSTMENTS_NOT_CONFIGURED', 'the billing-adjustment provider port is not configured');
    const req = await this.prisma.commercialChangeRequest.findUnique({ where: { id: cmd.change_request_id }, select: { state: true, action_type: true } });
    if (req === null || req.state !== 'APPLYING' || !(BILLING_COMMAND_KINDS_BY_ACTION[req.action_type] ?? []).includes(cmd.command_kind as BillingCommandKind)) {
      throw new CommandRefusal('REQUEST_NOT_APPLYING', `the change request is ${req?.state ?? 'missing'}; an adjustment is sent only for an approved request being applied`);
    }
    const r = adjustmentRequestOf(cmd);
    // Reconcile first (a read; allowed whatever the refund flag says, CCP-C4-R / TD-C4-12).
    const before = await this.adjustments.readAdjustmentEffect(r, cmd.provider_object_ref);
    if (before.tenant_id !== null && before.tenant_id !== cmd.tenant_id) throw new CommandRefusal('TENANT_MISMATCH', 'provider metadata tenant does not match the command');
    if (before.present) return { detail: 'already in effect at the provider', object_ref: before.object_ref };
    if (cmd.command_kind === 'REFUND_CREATE') {
      // CCP-C4-R — a refund already initiated for this command (any status, any amount) is never sent
      // again: it is reconciled (pending-provider) until the provider settles it.
      if (before.object_ref !== null) return { detail: `refund already initiated at the provider (${before.provider_status ?? 'unknown'})`, object_ref: before.object_ref };
      // The disabled flag blocks only NEW external execution (Architect C4 disposition, TD-C4-12).
      if (!refundExecutionEnabled()) throw new CommandRefusal(REFUND_POLICY_NOT_APPROVED, 'the refund policy is not approved; no new refund is sent to the provider');
      // TD-C4-1 identity: the amount is bounded by the payment's refundable remainder, in its currency.
      if (before.payment_currency !== undefined && before.payment_currency !== null && before.payment_currency.toUpperCase() !== String(r.currency)) {
        throw new CommandRefusal('REFUND_CURRENCY_MISMATCH', `the refund currency ${String(r.currency)} is not the payment currency ${before.payment_currency}`);
      }
      if (before.refundable_remainder_minor !== undefined && before.refundable_remainder_minor !== null && (r.amount_minor as number) > before.refundable_remainder_minor) {
        throw new CommandRefusal('REFUND_EXCEEDS_REMAINDER', 'the refund exceeds the payment\'s refundable remainder');
      }
    }
    const { object_ref } = await this.adjustments.executeAdjustment(r, cmd.idempotency_key);
    return { detail: `${cmd.command_kind} accepted by the provider`, object_ref };
  }

  /**
   * Reconciliation by provider re-fetch: for every command still awaiting confirmation
   * (PENDING_PROVIDER, or FAILED whose effect the provider may show anyway), re-fetch its target
   * and APPLY it; the applying transaction confirms the command. Each re-fetch runs outside any
   * local transaction. Returns the apply results (the caller handles owner activation).
   */
  async reconcilePending(product_key: ProductKey, at: Date, limit = 50): Promise<ReconcileTally> {
    assertProductKey(product_key);
    const rows = await this.prisma.billingProviderCommand.findMany({
      where: { product_key, state: { in: ['PENDING_PROVIDER', 'FAILED'] } },
      orderBy: [{ updated_at: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    const tally: ReconcileTally = { checked: 0, confirmed: 0, failed: 0, results: [] };
    const seen = new Set<string>();
    for (const c of rows) {
      const k = isAdjustmentCommandKind(c.command_kind) ? `${c.command_kind}:${c.id}` : `${c.command_kind}:${c.target_ref}`;
      if (seen.has(k)) continue;
      seen.add(k);
      tally.checked += 1;
      try {
        const res = isAdjustmentCommandKind(c.command_kind)
          ? await this.lifecycle.syncAdjustmentCommand(c.id, product_key, at, REFETCH_CONFIRMATION)
          : c.command_kind === 'SUBSCRIPTION_CANCEL'
            ? await this.lifecycle.syncSubscription(c.target_ref, product_key, at, REFETCH_CONFIRMATION)
            : await this.lifecycle.syncCheckoutSession(c.target_ref, product_key, at, REFETCH_CONFIRMATION);
        tally.results.push(res);
      } catch (err) {
        tally.failed += 1;
        if (!(err instanceof BillingProviderUnavailableError)) this.log.error(`billing command re-fetch failed: ${(err as Error).message}`);
      }
    }
    if (rows.length > 0) {
      tally.confirmed = await this.prisma.billingProviderCommand.count({ where: { id: { in: rows.map((r) => r.id) }, state: 'CONFIRMED' } });
    }
    return tally;
  }
}

