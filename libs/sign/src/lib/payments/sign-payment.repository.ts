import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository } from '../esign.repository.js';
import { isTerminalEnvelopeStatus } from '../domain/envelope-lifecycle.js';
import type { PaymentAccountState, PaymentCheckoutState, PaymentChargeState, PaymentRefundState } from '../ports/payment-provider.port.js';

// Aramo Sign 1.14 (Feature-Parity directive §1.14, R-6) — the payment records. Stripe
// object references and amounts only: no card data, no payer PII. Every change of a
// payment's state is also a hash-chained ledger event on the envelope (evidence).
//
// Ledger event types (SignatureEvent.event_type; payloads carry only ids, amounts and
// provider references):
export const PAYMENT_CHECKOUT_STARTED = 'PAYMENT_CHECKOUT_STARTED';
export const PAYMENT_SUCCEEDED = 'PAYMENT_SUCCEEDED';
export const PAYMENT_FAILED = 'PAYMENT_FAILED';
export const PAYMENT_REFUND_REQUESTED = 'PAYMENT_REFUND_REQUESTED';
export const PAYMENT_REFUNDED = 'PAYMENT_REFUNDED';
export const PAYMENT_REFUND_FAILED = 'PAYMENT_REFUND_FAILED';
export const PAYMENT_LEDGER_EVENT_TYPES: readonly string[] = [
  PAYMENT_CHECKOUT_STARTED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  PAYMENT_REFUND_REQUESTED,
  PAYMENT_REFUNDED,
  PAYMENT_REFUND_FAILED,
];

export type SignPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface SignPaymentAccountRow {
  id: string;
  tenant_id: string;
  account_ref: string;
  status: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  payouts_enabled: boolean;
  live: boolean;
  created_at: Date;
  updated_at: Date;
  disconnected_at: Date | null;
}

export interface SignPaymentRow {
  id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  field_id: string;
  account_ref: string;
  amount_minor: number;
  currency: string;
  application_fee_minor: number;
  status: string;
  checkout_ref: string | null;
  payment_ref: string | null;
  amount_refunded_minor: number;
  live: boolean;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface SignPaymentRefundRow {
  id: string;
  tenant_id: string;
  payment_id: string;
  amount_minor: number;
  status: string;
  refund_ref: string | null;
  reason: string | null;
  requested_by: string;
  created_at: Date;
}

// The receipt line printed in the PAYMENT field of the executed document.
export function formatPaymentAmount(amount_minor: number, currency: string): string {
  const whole = Math.trunc(amount_minor / 100);
  const cents = String(amount_minor % 100).padStart(2, '0');
  return currency === 'USD' ? `$${whole.toLocaleString('en-US')}.${cents} USD` : `${whole}.${cents} ${currency}`;
}

export function paymentReceiptText(amount_minor: number, currency: string): string {
  return `Paid ${formatPaymentAmount(amount_minor, currency)}`;
}

/** A payment state change was refused (wrong state, amount or account). */
export class SignPaymentStateError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'SignPaymentStateError';
  }
}

const OPEN_REFUND_STATUSES = ['REQUESTED', 'PENDING', 'SUCCEEDED'];

function refundedStatus(amount_minor: number, refunded_minor: number): SignPaymentStatus {
  if (refunded_minor <= 0) return 'PAID';
  return refunded_minor >= amount_minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

@Injectable()
export class SignPaymentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
  ) {}

  // ── Connected account ────────────────────────────────────────────────────────

  async getAccount(tenant_id: string): Promise<SignPaymentAccountRow | null> {
    return this.prisma.signPaymentAccount.findUnique({ where: { tenant_id } });
  }

  /** The tenant's CONNECTED account, or null. */
  async connectedAccount(tenant_id: string): Promise<SignPaymentAccountRow | null> {
    const row = await this.getAccount(tenant_id);
    return row !== null && row.status === 'CONNECTED' ? row : null;
  }

  /** Record a newly created (or re-read) account as the tenant's connected account. */
  async connect(tenant_id: string, state: PaymentAccountState, actor_user_id: string): Promise<SignPaymentAccountRow> {
    const now = new Date();
    const data = {
      account_ref: state.account_ref,
      status: 'CONNECTED',
      charges_enabled: state.charges_enabled,
      details_submitted: state.details_submitted,
      payouts_enabled: state.payouts_enabled,
      live: state.live,
      updated_at: now,
      disconnected_at: null,
      disconnected_by: null,
    };
    return this.prisma.signPaymentAccount.upsert({
      where: { tenant_id },
      create: { id: randomUUID(), tenant_id, provider: 'STRIPE_CONNECT', created_by: actor_user_id, created_at: now, ...data },
      update: data,
    });
  }

  /** Mirror the provider's account state (webhook or refresh). Unknown accounts are ignored. */
  async applyAccountState(state: PaymentAccountState): Promise<SignPaymentAccountRow | null> {
    const row = await this.prisma.signPaymentAccount.findUnique({ where: { account_ref: state.account_ref } });
    if (row === null) return null;
    return this.prisma.signPaymentAccount.update({
      where: { id: row.id },
      data: { charges_enabled: state.charges_enabled, details_submitted: state.details_submitted, payouts_enabled: state.payouts_enabled, live: state.live, updated_at: new Date() },
    });
  }

  /**
   * Disconnect: Aramo stops using the account (no new payments). The account itself is the
   * subscriber's (a Standard account) and stays theirs, with its funds and history. Earlier
   * payments keep their account_ref, so they can still be refunded.
   */
  async disconnect(tenant_id: string, actor_user_id: string): Promise<boolean> {
    const out = await this.prisma.signPaymentAccount.updateMany({
      where: { tenant_id, status: 'CONNECTED' },
      data: { status: 'DISCONNECTED', charges_enabled: false, disconnected_at: new Date(), disconnected_by: actor_user_id, updated_at: new Date() },
    });
    return out.count > 0;
  }

  /** The provider reported the platform's access to the account was revoked. */
  async disconnectByAccountRef(account_ref: string): Promise<boolean> {
    const out = await this.prisma.signPaymentAccount.updateMany({
      where: { account_ref, status: 'CONNECTED' },
      data: { status: 'DISCONNECTED', charges_enabled: false, disconnected_at: new Date(), updated_at: new Date() },
    });
    return out.count > 0;
  }

  // ── Payments ─────────────────────────────────────────────────────────────────

  async paymentForField(tenant_id: string, field_id: string): Promise<SignPaymentRow | null> {
    return this.prisma.signPayment.findFirst({ where: { tenant_id, field_id } });
  }

  async getPayment(tenant_id: string, payment_id: string): Promise<SignPaymentRow | null> {
    return this.prisma.signPayment.findFirst({ where: { tenant_id, id: payment_id } });
  }

  async listForEnvelope(tenant_id: string, envelope_id: string): Promise<Array<SignPaymentRow & { refunds: SignPaymentRefundRow[] }>> {
    return this.prisma.signPayment.findMany({
      where: { tenant_id, envelope_id },
      include: { refunds: { orderBy: { created_at: 'asc' } } },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * The payment row for a PAYMENT field (created PENDING on first use). A PAID (or
   * refunded) payment is never charged again. The account and fee are re-pinned while
   * the payment is still unpaid, so a reconnected account is used for the next attempt.
   */
  async preparePayment(input: {
    tenant_id: string;
    envelope_id: string;
    signer_id: string;
    field_id: string;
    account_ref: string;
    amount_minor: number;
    currency: string;
    application_fee_minor: number;
  }): Promise<SignPaymentRow> {
    const existing = await this.paymentForField(input.tenant_id, input.field_id);
    if (existing !== null) {
      if (existing.status !== 'PENDING' && existing.status !== 'FAILED') {
        throw new SignPaymentStateError('payment_already_completed', 'This payment has already been made');
      }
      if (existing.signer_id !== input.signer_id || existing.envelope_id !== input.envelope_id) {
        throw new SignPaymentStateError('payment_field_mismatch', 'This payment belongs to another recipient');
      }
      return this.prisma.signPayment.update({
        where: { id: existing.id },
        data: {
          account_ref: input.account_ref,
          amount_minor: input.amount_minor,
          currency: input.currency,
          application_fee_minor: input.application_fee_minor,
          status: 'PENDING',
          updated_at: new Date(),
        },
      });
    }
    return this.prisma.signPayment.create({
      data: { id: randomUUID(), ...input, status: 'PENDING' },
    });
  }

  /** The checkout the payer was sent to, recorded with its ledger event (under the envelope lock). */
  async recordCheckoutStarted(payment: SignPaymentRow, checkout: PaymentCheckoutState): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx, payment.tenant_id, payment.envelope_id);
      await tx.signPayment.update({ where: { id: payment.id }, data: { checkout_ref: checkout.checkout_ref, live: checkout.live, updated_at: new Date() } });
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: PAYMENT_CHECKOUT_STARTED,
        actor_type: 'SIGNER',
        actor_ref: payment.signer_id,
        payload: {
          payment_id: payment.id,
          field_id: payment.field_id,
          amount_minor: payment.amount_minor,
          currency: payment.currency,
          application_fee_minor: payment.application_fee_minor,
          checkout_ref: checkout.checkout_ref,
          provider: 'STRIPE_CONNECT',
        },
      });
    });
  }

  /**
   * A checkout the provider reports paid (webhook or the payer's return). Idempotent: a
   * payment already recorded PAID returns 'ALREADY'. The checkout must belong to this
   * payment's account and match its amount and currency, or nothing is recorded.
   * The PAYMENT field is filled with the receipt line in the same transaction, unless the
   * envelope has already ended (voided, declined or expired) — the payment is still
   * recorded so the sender can refund it.
   */
  async recordPaid(checkout: PaymentCheckoutState, account_ref: string | null): Promise<'APPLIED' | 'ALREADY' | 'UNKNOWN'> {
    if (!checkout.paid || checkout.payment_ref === null) return 'UNKNOWN';
    const payment =
      (checkout.payment_id !== null ? await this.prisma.signPayment.findUnique({ where: { id: checkout.payment_id } }) : null) ??
      (await this.prisma.signPayment.findUnique({ where: { checkout_ref: checkout.checkout_ref } }));
    if (payment === null) return 'UNKNOWN';
    if (account_ref !== null && account_ref !== payment.account_ref) {
      throw new SignPaymentStateError('payment_account_mismatch', 'The checkout was not made on the payment account');
    }
    if (checkout.amount_minor !== payment.amount_minor || (checkout.currency ?? '').toUpperCase() !== payment.currency) {
      throw new SignPaymentStateError('payment_amount_mismatch', 'The checkout amount does not match the payment');
    }
    return this.prisma.$transaction(async (tx) => {
      const status = await this.repo.lockEnvelope(tx, payment.tenant_id, payment.envelope_id);
      const current = await tx.signPayment.findUniqueOrThrow({ where: { id: payment.id } });
      if (current.status !== 'PENDING' && current.status !== 'FAILED') return 'ALREADY' as const;
      const now = new Date();
      await tx.signPayment.update({
        where: { id: payment.id },
        data: { status: 'PAID', payment_ref: checkout.payment_ref, checkout_ref: checkout.checkout_ref, live: checkout.live, paid_at: now, updated_at: now },
      });
      const terminal = isTerminalEnvelopeStatus(status);
      if (!terminal) {
        await tx.signatureField.updateMany({
          where: { id: payment.field_id, tenant_id: payment.tenant_id, filled_at: null },
          data: { value: paymentReceiptText(payment.amount_minor, payment.currency), signature_method: null, filled_at: now },
        });
      }
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: PAYMENT_SUCCEEDED,
        actor_type: 'SYSTEM',
        payload: {
          payment_id: payment.id,
          field_id: payment.field_id,
          amount_minor: payment.amount_minor,
          currency: payment.currency,
          application_fee_minor: payment.application_fee_minor,
          payment_ref: checkout.payment_ref,
          checkout_ref: checkout.checkout_ref,
          account_ref: payment.account_ref,
          live: checkout.live,
          ...(terminal ? { envelope_status: status } : {}),
        },
      });
      return 'APPLIED' as const;
    });
  }

  /** An asynchronous payment the provider reports failed. Only an unpaid payment changes. */
  async recordFailed(checkout: PaymentCheckoutState): Promise<'APPLIED' | 'IGNORED'> {
    const payment =
      (checkout.payment_id !== null ? await this.prisma.signPayment.findUnique({ where: { id: checkout.payment_id } }) : null) ??
      (await this.prisma.signPayment.findUnique({ where: { checkout_ref: checkout.checkout_ref } }));
    if (payment === null || payment.status !== 'PENDING') return 'IGNORED';
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx, payment.tenant_id, payment.envelope_id);
      await tx.signPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', updated_at: new Date() } });
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: PAYMENT_FAILED,
        actor_type: 'SYSTEM',
        payload: { payment_id: payment.id, field_id: payment.field_id, checkout_ref: checkout.checkout_ref },
      });
    });
    return 'APPLIED';
  }

  // ── Refunds ──────────────────────────────────────────────────────────────────

  /**
   * Record a refund request (before the provider is called). The amount must fit in what
   * is still refundable: the paid amount less every refund already requested, pending or
   * done. Serialized per payment by its row lock.
   */
  async requestRefund(input: { tenant_id: string; payment_id: string; amount_minor: number | null; reason: string | null; requested_by: string }): Promise<{ payment: SignPaymentRow; refund: SignPaymentRefundRow }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "sign"."SignPayment" WHERE id = ${input.payment_id}::uuid AND tenant_id = ${input.tenant_id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new SignPaymentStateError('payment_not_found', 'Payment not found');
      const payment = await tx.signPayment.findUniqueOrThrow({ where: { id: input.payment_id } });
      if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new SignPaymentStateError('payment_not_refundable', 'Only a paid payment can be refunded');
      }
      const open = await tx.signPaymentRefund.findMany({ where: { payment_id: payment.id, status: { in: OPEN_REFUND_STATUSES } }, select: { amount_minor: true } });
      const committed = Math.max(payment.amount_refunded_minor, open.reduce((n, r) => n + r.amount_minor, 0));
      const refundable = payment.amount_minor - committed;
      const amount = input.amount_minor ?? refundable;
      if (!Number.isInteger(amount) || amount <= 0 || amount > refundable) {
        throw new SignPaymentStateError('refund_amount_invalid', `The refund must be between 1 and ${refundable} cents`);
      }
      const refund = await tx.signPaymentRefund.create({
        data: { id: randomUUID(), tenant_id: payment.tenant_id, payment_id: payment.id, amount_minor: amount, status: 'REQUESTED', reason: input.reason, requested_by: input.requested_by },
      });
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: PAYMENT_REFUND_REQUESTED,
        actor_type: 'SERVICE',
        actor_ref: input.requested_by,
        payload: { payment_id: payment.id, refund_id: refund.id, amount_minor: amount, currency: payment.currency },
      });
      return { payment, refund };
    });
  }

  /**
   * The provider's answer for a refund (on creation, or a later webhook). SUCCEEDED adds
   * the amount to the payment's refunded total once; FAILED / CANCELED release it.
   */
  async applyRefundState(state: PaymentRefundState & { payment_ref?: string | null }, fallback_refund_id?: string): Promise<'APPLIED' | 'ALREADY' | 'UNKNOWN'> {
    const refund =
      (await this.prisma.signPaymentRefund.findUnique({ where: { refund_ref: state.refund_ref } })) ??
      (state.refund_id !== null ? await this.prisma.signPaymentRefund.findUnique({ where: { id: state.refund_id } }) : null) ??
      (fallback_refund_id !== undefined ? await this.prisma.signPaymentRefund.findUnique({ where: { id: fallback_refund_id } }) : null);
    if (refund === null) return 'UNKNOWN';
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.signPayment.findUniqueOrThrow({ where: { id: refund.payment_id } });
      await this.repo.lockEnvelope(tx, payment.tenant_id, payment.envelope_id);
      const current = await tx.signPaymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
      if (current.status === 'SUCCEEDED' || current.status === 'FAILED' || current.status === 'CANCELED') {
        if (current.refund_ref === null) await tx.signPaymentRefund.update({ where: { id: refund.id }, data: { refund_ref: state.refund_ref } });
        return 'ALREADY' as const;
      }
      await tx.signPaymentRefund.update({ where: { id: refund.id }, data: { status: state.status, refund_ref: state.refund_ref, updated_at: new Date() } });
      if (state.status === 'PENDING') return 'APPLIED' as const;
      if (state.status === 'SUCCEEDED') {
        const refunded = Math.min(payment.amount_minor, payment.amount_refunded_minor + current.amount_minor);
        await tx.signPayment.update({ where: { id: payment.id }, data: { amount_refunded_minor: refunded, status: refundedStatus(payment.amount_minor, refunded), updated_at: new Date() } });
      }
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: state.status === 'SUCCEEDED' ? PAYMENT_REFUNDED : PAYMENT_REFUND_FAILED,
        actor_type: 'SYSTEM',
        payload: { payment_id: payment.id, refund_id: refund.id, refund_ref: state.refund_ref, amount_minor: current.amount_minor, currency: payment.currency, status: state.status },
      });
      return 'APPLIED' as const;
    });
  }

  /** A refund the provider refused outright (no provider object): released, with its ledger event. */
  async refundRefused(refund_id: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.signPaymentRefund.findUniqueOrThrow({ where: { id: refund_id } });
      if (refund.status !== 'REQUESTED') return;
      const payment = await tx.signPayment.findUniqueOrThrow({ where: { id: refund.payment_id } });
      await this.repo.lockEnvelope(tx, payment.tenant_id, payment.envelope_id);
      await tx.signPaymentRefund.update({ where: { id: refund.id }, data: { status: 'FAILED', updated_at: new Date() } });
      await this.repo.appendEvent(tx, {
        tenant_id: payment.tenant_id,
        envelope_id: payment.envelope_id,
        signer_id: payment.signer_id,
        event_type: PAYMENT_REFUND_FAILED,
        actor_type: 'SYSTEM',
        payload: { payment_id: payment.id, refund_id: refund.id, amount_minor: refund.amount_minor, currency: payment.currency, status: 'FAILED', reason: reason.slice(0, 200) },
      });
    });
  }

  /**
   * The provider's refunded total for a charge (it also covers refunds made outside Aramo,
   * e.g. in the subscriber's own Stripe dashboard). The payment's refunded total only grows.
   */
  async applyChargeRefunds(charge: PaymentChargeState, account_ref: string | null): Promise<'APPLIED' | 'IGNORED'> {
    const payment = await this.prisma.signPayment.findUnique({ where: { payment_ref: charge.payment_ref } });
    if (payment === null || (account_ref !== null && account_ref !== payment.account_ref)) return 'IGNORED';
    const refunded = Math.min(payment.amount_minor, Math.max(payment.amount_refunded_minor, charge.amount_refunded_minor));
    if (refunded === payment.amount_refunded_minor) return 'IGNORED';
    await this.prisma.signPayment.update({ where: { id: payment.id }, data: { amount_refunded_minor: refunded, status: refundedStatus(payment.amount_minor, refunded), updated_at: new Date() } });
    return 'APPLIED';
  }

  // ── Webhook inbox ────────────────────────────────────────────────────────────

  /** Record a verified event. False when it was already processed (a redelivery). */
  async receiveWebhookEvent(event_ref: string, event_type: string, account_ref: string | null): Promise<boolean> {
    const existing = await this.prisma.signPaymentWebhookEvent.findUnique({ where: { event_ref } });
    if (existing !== null) return existing.processed_at === null || existing.outcome === 'FAILED';
    try {
      await this.prisma.signPaymentWebhookEvent.create({ data: { event_ref, event_type, account_ref } });
    } catch {
      // A concurrent delivery of the same event recorded it first.
      return false;
    }
    return true;
  }

  async finishWebhookEvent(event_ref: string, outcome: 'APPLIED' | 'IGNORED' | 'FAILED'): Promise<void> {
    await this.prisma.signPaymentWebhookEvent.update({ where: { event_ref }, data: { outcome, processed_at: new Date() } });
  }
}
