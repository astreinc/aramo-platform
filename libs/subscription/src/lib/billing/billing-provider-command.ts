// CCP-C1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C1; Conversion Rule C-22, C-23)
// — the Stripe command outbox: the closed command set, the derived idempotency key, the state
// machine (mirrored by the DB trigger of migration 20261026020000) and the confirmation rule.
//
// A command is CONFIRMED only inside the local transaction that APPLIES the provider-confirmed
// state (SubscriptionLifecycleService.applyProviderState / syncCheckoutSession, under the billing
// lock), whether that state arrived by verified webhook or by provider re-fetch. Until then it is
// pending-provider (C-23): nothing reports the external change as committed on local commit.

import type { ProviderCheckoutSessionState, ProviderSubscriptionState } from './billing-provider.port.js';

export const BILLING_COMMAND_KINDS = ['SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE'] as const;
export type BillingCommandKind = (typeof BILLING_COMMAND_KINDS)[number];

export const BILLING_COMMAND_STATES = ['PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED', 'CONFIRMED'] as const;
export type BillingCommandState = (typeof BILLING_COMMAND_STATES)[number];

/** The states in which the external change is NOT yet provider-confirmed (C-23). */
export const BILLING_COMMAND_UNCONFIRMED_STATES: readonly BillingCommandState[] = ['PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED'];

export const SUBSCRIPTION_CANCEL_MODES = ['IMMEDIATE', 'AT_PERIOD_END'] as const;
export type SubscriptionCancelMode = (typeof SUBSCRIPTION_CANCEL_MODES)[number];

export type BillingCommandParams = { mode: SubscriptionCancelMode } | Record<string, never>;

/**
 * The change-request action types that may issue provider commands (DB trigger mirror). C1:
 * CONVERSION (Conv. C-13, C-17 dispositions via C2). C4 adds CREDIT / DISCOUNT.
 */
export const BILLING_COMMAND_ACTIONS: readonly string[] = ['CONVERSION'];

/** A command may be enqueued only once its request completed the approval chain. */
export const BILLING_COMMAND_REQUEST_STATES: readonly string[] = ['APPROVED', 'APPLYING', 'APPLY_FAILED'];

export const BILLING_COMMAND_STEP = /^[a-z][a-z0-9_]{0,62}$/;

/** Conversion Rule C-22 — the idempotency key derived from the change request and the step. */
export function billingCommandIdempotencyKey(change_request_id: string, step: string): string {
  return `aramo-ccp-${change_request_id}-${step}`;
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
