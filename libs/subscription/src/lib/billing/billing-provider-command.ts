// CCP-C1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C1; Conversion Rule C-22, C-23)
// — the Stripe command outbox: the closed command set, the derived idempotency key, the state
// machine (mirrored by the DB trigger of migration 20261026020000) and the confirmation rule.
//
// A command is CONFIRMED only inside the local transaction that APPLIES the provider-confirmed
// state (SubscriptionLifecycleService.applyProviderState / syncCheckoutSession, under the billing
// lock), whether that state arrived by verified webhook or by provider re-fetch. Until then it is
// pending-provider (C-23): nothing reports the external change as committed on local commit.

import type { ProviderAdjustmentRequest, ProviderCheckoutSessionState, ProviderSubscriptionState } from './billing-provider.port.js';

/**
 * CCP-C4 — the adjustment command kinds (one per Stripe-side operation):
 *   CREDIT_GRANT     a credit to the provider account balance (applied to the next invoice)
 *   CREDIT_REVERSE   the compensation of an applied credit (the equal debit)
 *   DISCOUNT_APPLY   a percent-off discount on the provider subscription (next invoice only)
 *   DISCOUNT_REMOVE  the compensation of an applied discount (its removal)
 *   REFUND_CREATE    a refund of a paid invoice (designed disabled state: REFUND_POLICY_NOT_APPROVED)
 */
const C4_ADJUSTMENT_COMMAND_KINDS_LIST = ['CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE'] as const;
export const C4_ADJUSTMENT_COMMAND_KINDS: readonly string[] = C4_ADJUSTMENT_COMMAND_KINDS_LIST;
export type AdjustmentCommandKind = (typeof C4_ADJUSTMENT_COMMAND_KINDS_LIST)[number];
export function isAdjustmentCommandKind(kind: string): kind is AdjustmentCommandKind {
  return C4_ADJUSTMENT_COMMAND_KINDS.includes(kind);
}

export const BILLING_COMMAND_KINDS = [
  'SUBSCRIPTION_CANCEL',
  'CHECKOUT_SESSION_EXPIRE',
  // CCP-C4 — the Stripe-side billing adjustments (Conv. C-22: "credits, refunds and discounts").
  ...C4_ADJUSTMENT_COMMAND_KINDS_LIST,
] as const;
export type BillingCommandKind = (typeof BILLING_COMMAND_KINDS)[number];

export const BILLING_COMMAND_STATES = ['PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED', 'CONFIRMED'] as const;
export type BillingCommandState = (typeof BILLING_COMMAND_STATES)[number];

/** The states in which the external change is NOT yet provider-confirmed (C-23). */
export const BILLING_COMMAND_UNCONFIRMED_STATES: readonly BillingCommandState[] = ['PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED'];

export const SUBSCRIPTION_CANCEL_MODES = ['IMMEDIATE', 'AT_PERIOD_END'] as const;
export type SubscriptionCancelMode = (typeof SUBSCRIPTION_CANCEL_MODES)[number];

/**
 * CCP-C4 adjustment params (closed per kind; DB CHECK "BillingProviderCommand_c4_params_check"):
 *   CREDIT_GRANT / CREDIT_REVERSE  { subscription_id, amount_minor, currency }              (target_ref = the provider account)
 *   DISCOUNT_APPLY                 { subscription_id, discount_bps, coupon_ref }            (target_ref = the provider subscription)
 *   DISCOUNT_REMOVE                { subscription_id, coupon_ref }                          (target_ref = the provider subscription)
 *   REFUND_CREATE                  { subscription_id, amount_minor, currency, account_ref } (target_ref = the provider invoice)
 * `subscription_id` is the Aramo self-service row the adjustment acts on (resolved at apply).
 */
export type AdjustmentCommandParams =
  | { subscription_id: string; amount_minor: number; currency: string }
  | { subscription_id: string; discount_bps: number; coupon_ref: string }
  | { subscription_id: string; coupon_ref: string }
  | { subscription_id: string; amount_minor: number; currency: string; account_ref: string };

/** The closed C4 param keys per kind (TS mirror of the DB CHECK). */
export const ADJUSTMENT_PARAM_KEYS: Readonly<Record<AdjustmentCommandKind, readonly string[]>> = {
  CREDIT_GRANT: ['subscription_id', 'amount_minor', 'currency'],
  CREDIT_REVERSE: ['subscription_id', 'amount_minor', 'currency'],
  DISCOUNT_APPLY: ['subscription_id', 'discount_bps', 'coupon_ref'],
  DISCOUNT_REMOVE: ['subscription_id', 'coupon_ref'],
  REFUND_CREATE: ['subscription_id', 'amount_minor', 'currency', 'account_ref'],
};

export type BillingCommandParams = { mode: SubscriptionCancelMode } | AdjustmentCommandParams | Record<string, never>;

/**
 * The change-request action types that may issue provider commands (DB trigger mirror). C1:
 * CONVERSION (Conv. C-13, C-17 dispositions via C2). C4 adds CREDIT / DISCOUNT.
 */
export const BILLING_COMMAND_ACTIONS: readonly string[] = ['CONVERSION', 'CREDIT', 'DISCOUNT', 'REFUND'];

/** CCP-C4 — which command kinds each command-issuing action may enqueue (TS + DB mirror). */
export const BILLING_COMMAND_KINDS_BY_ACTION: Readonly<Record<string, readonly BillingCommandKind[]>> = {
  CONVERSION: ['SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE'],
  CREDIT: ['CREDIT_GRANT', 'CREDIT_REVERSE'],
  DISCOUNT: ['DISCOUNT_APPLY', 'DISCOUNT_REMOVE'],
  REFUND: ['REFUND_CREATE'],
};

/** A command may be enqueued only once its request completed the approval chain. */
export const BILLING_COMMAND_REQUEST_STATES: readonly string[] = ['APPROVED', 'APPLYING', 'APPLY_FAILED'];

export const BILLING_COMMAND_STEP = /^[a-z][a-z0-9_]{0,62}$/;

/** Conversion Rule C-22 — the idempotency key derived from the change request and the step. */
export function billingCommandIdempotencyKey(change_request_id: string, step: string): string {
  return `aramo-ccp-${change_request_id}-${step}`;
}

/**
 * CCP-C7 — the key of a TENANT-originated command (an owner-made SelfServiceBillingRequest, Charter
 * :99), derived the same way from that request and the step (C-22; DB CHECK
 * BillingProviderCommand_idempotency_key_check, migration 20261028030000).
 */
export function selfServiceCommandIdempotencyKey(self_service_request_id: string, step: string): string {
  return `aramo-ccp-ss-${self_service_request_id}-${step}`;
}

/** The DB transition table (guard_billing_provider_command), for the unit mirror test. */
export const BILLING_COMMAND_TRANSITIONS: Readonly<Record<BillingCommandState, readonly BillingCommandState[]>> = {
  PENDING: ['DISPATCHING', 'CONFIRMED'],
  DISPATCHING: ['DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED', 'CONFIRMED'],
  PENDING_PROVIDER: ['CONFIRMED'],
  RETRY_WAIT: ['DISPATCHING', 'CONFIRMED'],
  FAILED: ['PENDING', 'CONFIRMED'],
  CONFIRMED: [],
};

export function canTransitionBillingCommand(from: BillingCommandState, to: BillingCommandState): boolean {
  return BILLING_COMMAND_TRANSITIONS[from].includes(to);
}

/** Automatic attempts before a transiently failing command is FAILED (surfaced, never dropped). */
export const BILLING_COMMAND_MAX_ATTEMPTS = 8;
/** A claim lease: a dispatcher that dies mid-call releases the command after this. */
export const BILLING_COMMAND_LEASE_MS = 5 * 60_000;

/** Exponential backoff after attempt n (1-based): 1, 2, 4 … minutes, capped at 6 h. */
export function billingCommandBackoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 6 * 60 * 60_000);
}

export type BillingCommandConfirmationSource = 'WEBHOOK' | 'REFETCH';
export interface BillingCommandConfirmation {
  source: BillingCommandConfirmationSource;
  event_id: string | null;
}
export const REFETCH_CONFIRMATION: BillingCommandConfirmation = { source: 'REFETCH', event_id: null };

export function cancelModeOf(params: unknown): SubscriptionCancelMode | null {
  const m = (params as { mode?: unknown } | null)?.mode;
  return m === 'IMMEDIATE' || m === 'AT_PERIOD_END' ? m : null;
}

/**
 * Does this provider subscription state show the cancel in effect? IMMEDIATE: the subscription has
 * ended at the provider. AT_PERIOD_END: the cancellation is scheduled (or it has already ended).
 */
export function subscriptionCancelConfirmed(params: unknown, state: Pick<ProviderSubscriptionState, 'cancel_at_period_end'>, ends: boolean): boolean {
  const mode = cancelModeOf(params);
  if (mode === 'IMMEDIATE') return ends;
  if (mode === 'AT_PERIOD_END') return ends || state.cancel_at_period_end;
  return false;
}

export function sessionExpireConfirmed(session: Pick<ProviderCheckoutSessionState, 'status'>): boolean {
  return session.status === 'expired';
}

type CommandRow = { id: string; params: unknown };
type CommandTx = {
  billingProviderCommand: {
    findMany(args: { where: Record<string, unknown> }): Promise<CommandRow[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
};

async function confirmRows(tx: CommandTx, rows: readonly CommandRow[], confirmation: BillingCommandConfirmation, at: Date): Promise<string[]> {
  const ids: string[] = [];
  for (const c of rows) {
    await tx.billingProviderCommand.update({
      where: { id: c.id },
      data: {
        state: 'CONFIRMED',
        confirmed_at: at,
        confirmation_source: confirmation.source,
        confirmation_event_id: confirmation.event_id,
        lease_until: null,
        next_attempt_at: null,
        updated_at: at,
      },
    });
    ids.push(c.id);
  }
  return ids;
}

/**
 * In the transaction that applied `state` (under the billing lock): CONFIRM every unconfirmed
 * SUBSCRIPTION_CANCEL command of this tenant and product on this provider subscription whose
 * effect the applied state shows. Returns the confirmed command ids.
 */
export async function confirmSubscriptionCommandsInTx(
  tx: CommandTx,
  input: { tenant_id: string; product_key: string; state: ProviderSubscriptionState; ends: boolean; confirmation: BillingCommandConfirmation; at: Date },
): Promise<string[]> {
  const rows = await tx.billingProviderCommand.findMany({
    where: {
      provider: input.state.provider,
      target_ref: input.state.subscription_ref,
      command_kind: 'SUBSCRIPTION_CANCEL',
      tenant_id: input.tenant_id,
      product_key: input.product_key,
      state: { in: [...BILLING_COMMAND_UNCONFIRMED_STATES] },
    },
  });
  return confirmRows(
    tx,
    rows.filter((c) => subscriptionCancelConfirmed(c.params, input.state, input.ends)),
    input.confirmation,
    input.at,
  );
}

/** The same for CHECKOUT_SESSION_EXPIRE commands on an expired session. */
export async function confirmSessionCommandsInTx(
  tx: CommandTx,
  input: { tenant_id: string; product_key: string; session: ProviderCheckoutSessionState; confirmation: BillingCommandConfirmation; at: Date },
): Promise<string[]> {
  if (!sessionExpireConfirmed(input.session)) return [];
  const rows = await tx.billingProviderCommand.findMany({
    where: {
      provider: input.session.provider,
      target_ref: input.session.session_ref,
      command_kind: 'CHECKOUT_SESSION_EXPIRE',
      tenant_id: input.tenant_id,
      product_key: input.product_key,
      state: { in: [...BILLING_COMMAND_UNCONFIRMED_STATES] },
    },
  });
  return confirmRows(tx, rows, input.confirmation, input.at);
}

const ADJ_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CCP-C4 — the closed params of an adjustment kind (TS mirror of BillingProviderCommand_c4_params_check). */
export function adjustmentParamErrors(kind: BillingCommandKind, params: unknown): string[] {
  if (!isAdjustmentCommandKind(kind)) return [];
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return [`a ${kind} command needs its params`];
  const p = params as Record<string, unknown>;
  const errors: string[] = [];
  const keys = ADJUSTMENT_PARAM_KEYS[kind];
  for (const k of Object.keys(p)) if (!keys.includes(k)) errors.push(`${k} is not a ${kind} param`);
  for (const k of keys) if (p[k] === undefined) errors.push(`${k} is required for ${kind}`);
  if (p['subscription_id'] !== undefined && !(typeof p['subscription_id'] === 'string' && ADJ_UUID.test(p['subscription_id']))) errors.push('subscription_id must be a uuid');
  if (p['amount_minor'] !== undefined && !(typeof p['amount_minor'] === 'number' && Number.isSafeInteger(p['amount_minor']) && p['amount_minor'] >= 1)) errors.push('amount_minor must be a positive integer');
  if (p['currency'] !== undefined && !(typeof p['currency'] === 'string' && /^[A-Z]{3}$/.test(p['currency']))) errors.push('currency must be an ISO 4217 code');
  if (p['discount_bps'] !== undefined && !(typeof p['discount_bps'] === 'number' && Number.isSafeInteger(p['discount_bps']) && p['discount_bps'] >= 1 && p['discount_bps'] <= 10_000)) errors.push('discount_bps must be 1-10000');
  for (const k of ['coupon_ref', 'account_ref']) if (p[k] !== undefined && !(typeof p[k] === 'string' && (p[k] as string).length >= 1 && (p[k] as string).length <= 255)) errors.push(`${k} must be 1-255 characters`);
  return errors;
}

/** CCP-C4 — the provider request a command describes (never anything the command does not carry). */
export function adjustmentRequestOf(cmd: { id: string; command_kind: string; tenant_id: string; target_ref: string; params: unknown }): ProviderAdjustmentRequest {
  const p = (cmd.params ?? {}) as Record<string, unknown>;
  return {
    operation: cmd.command_kind as ProviderAdjustmentRequest['operation'],
    command_id: cmd.id,
    tenant_id: cmd.tenant_id,
    target_ref: cmd.target_ref,
    ...(typeof p['account_ref'] === 'string' ? { account_ref: p['account_ref'] } : {}),
    ...(typeof p['amount_minor'] === 'number' ? { amount_minor: p['amount_minor'] } : {}),
    ...(typeof p['currency'] === 'string' ? { currency: p['currency'] } : {}),
    ...(typeof p['discount_bps'] === 'number' ? { discount_bps: p['discount_bps'] } : {}),
    ...(typeof p['coupon_ref'] === 'string' ? { coupon_ref: p['coupon_ref'] } : {}),
  };
}
