import { Injectable } from '@nestjs/common';

import { BILLING_COMMAND_UNCONFIRMED_STATES, isAdjustmentCommandKind } from '../billing/billing-provider-command.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { REFUND_AUDIT_EVENTS } from './commercial-billing-adjustment.js';

// CCP-C4-P (Amendment A1 RF-2, RF-10; Architect C4-P gap 3) — the READ-ONLY refund report, a
// projection of the existing records ONLY (change requests, CommercialBillingAdjustment, the C1
// commands and the commercial audit). No ledger table, no write.
//
// Per REFUND request: its refund state, category, accounting period (the UTC month of the effective
// date), effective date (the provider confirmation time of its command) and reconciliation status.
// Monetary fields are returned only to a caller holding `platform:billing:amount:read` (the LOCKED
// Finance amount scope, FAS-2); otherwise the amount is omitted and marked
// `amount_withheld: "FINANCE_SCOPE_REQUIRED"`. The scope check is CCP-R3's shared one
// (`financeAmountAccess`, via platform-admin `finance-amount-access.ts`; merge train TD-C4P-6).

/** requested | approved | pending | confirmed | failed | reconciled, plus `closed` (ended without any execution). */
export const REFUND_REPORT_STATES = ['requested', 'approved', 'pending', 'confirmed', 'failed', 'reconciled', 'closed'] as const;
export type RefundReportState = (typeof REFUND_REPORT_STATES)[number];
export type RefundReconciliationStatus = 'NOT_SENT' | 'PENDING_PROVIDER' | 'COMMAND_FAILED' | 'CONFIRMED' | 'RESOLVED_NOT_EXECUTED';

export interface RefundReportRow {
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  request_state: string;
  refund_state: RefundReportState;
  reconciliation_status: RefundReconciliationStatus;
  category: string | null;
  provider_invoice_ref: string | null;
  provider_payment_ref: string | null;
  provider_refund_ref: string | null;
  currency: string | null;
  /** Internal; the route returns it only with the Finance amount scope. */
  amount_minor: number | null;
  effective_at: Date | null;
  accounting_period: string | null;
  requested_by: string;
  created_at: Date;
  applied_at: Date | null;
}

export interface RefundReportQuery {
  tenant_id?: string;
  product_key?: string;
  limit?: number;
  cursor?: string;
}

export class RefundReportQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundReportQueryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(at: Date, id: string, filter: string): string {
  return Buffer.from(JSON.stringify({ c: at.toISOString(), i: id, f: filter }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string, filter: string): { at: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown; f?: unknown };
    const at = typeof v.c === 'string' ? new Date(v.c) : null;
    if (at === null || Number.isNaN(at.getTime()) || typeof v.i !== 'string' || !UUID.test(v.i) || v.f !== filter) throw new Error('bad');
    return { at, id: v.i };
  } catch {
    throw new RefundReportQueryError('invalid cursor');
  }
}

/** The UTC accounting month (YYYY-MM) of an effective date. */
export function accountingPeriodOf(at: Date | null): string | null {
  return at === null ? null : `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The pure projection of one request (and its commands / resolution evidence). */
export function refundReportState(
  request_state: string,
  commands: ReadonlyArray<{ state: string; confirmed_at: Date | null }>,
  resolved: boolean,
): { refund_state: RefundReportState; reconciliation_status: RefundReconciliationStatus } {
  const anyCmd = commands.length > 0;
  const allFailed = anyCmd && commands.every((c) => c.state === 'FAILED');
  const unconfirmed = commands.some((c) => (BILLING_COMMAND_UNCONFIRMED_STATES as readonly string[]).includes(c.state));
  switch (request_state) {
    case 'DRAFT':
    case 'PENDING_APPROVAL':
      return { refund_state: 'requested', reconciliation_status: 'NOT_SENT' };
    case 'APPROVED':
      return { refund_state: 'approved', reconciliation_status: 'NOT_SENT' };
    case 'APPLYING':
      return { refund_state: 'pending', reconciliation_status: allFailed ? 'COMMAND_FAILED' : unconfirmed ? 'PENDING_PROVIDER' : 'NOT_SENT' };
    case 'APPLIED':
      return { refund_state: 'confirmed', reconciliation_status: 'CONFIRMED' };
    case 'APPLY_FAILED':
      return { refund_state: 'failed', reconciliation_status: 'NOT_SENT' };
    case 'WITHDRAWN':
      if (resolved) return { refund_state: 'reconciled', reconciliation_status: 'RESOLVED_NOT_EXECUTED' };
      return { refund_state: 'closed', reconciliation_status: 'NOT_SENT' };
    default: // REJECTED, EXPIRED, APPLY_EXPIRED
      return { refund_state: 'closed', reconciliation_status: 'NOT_SENT' };
  }
}

@Injectable()
export class CommercialRefundReportService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: RefundReportQuery): Promise<{ refunds: RefundReportRow[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const filter = JSON.stringify([q.tenant_id ?? null, q.product_key ?? null]);
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor, filter);
    const reqs = await this.prisma.commercialChangeRequest.findMany({
      where: {
        action_type: 'REFUND',
        ...(q.tenant_id !== undefined ? { tenant_id: q.tenant_id } : {}),
        ...(q.product_key !== undefined ? { product_key: q.product_key } : {}),
        ...(after !== null ? { OR: [{ created_at: { lt: after.at } }, { created_at: after.at, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = reqs.slice(0, limit);
    const ids = page.map((r) => r.id);
    const [cmds, adjs, resolutions] = await Promise.all([
      this.prisma.billingProviderCommand.findMany({ where: { change_request_id: { in: ids } }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }),
      this.prisma.commercialBillingAdjustment.findMany({ where: { change_request_id: { in: ids } } }),
      this.prisma.commercialAuditEvent.findMany({ where: { change_request_id: { in: ids }, event_type: REFUND_AUDIT_EVENTS.RESOLVED_NOT_EXECUTED }, select: { change_request_id: true } }),
    ]);
    const resolved = new Set(resolutions.map((r) => r.change_request_id));
    const refunds: RefundReportRow[] = page.map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const mine = cmds.filter((c) => c.change_request_id === r.id && isAdjustmentCommandKind(c.command_kind));
      const adj = adjs.find((a) => a.change_request_id === r.id) ?? null;
      const s = refundReportState(r.state, mine, resolved.has(r.id));
      const confirmedCmd = adj === null ? null : (mine.find((c) => c.id === adj.command_id) ?? null);
      const effective_at = s.refund_state === 'confirmed' ? (confirmedCmd?.confirmed_at ?? adj?.applied_at ?? null) : null;
      return {
        change_request_id: r.id,
        tenant_id: r.tenant_id as string,
        product_key: r.product_key as string,
        request_state: r.state,
        refund_state: s.refund_state,
        reconciliation_status: s.reconciliation_status,
        category: typeof p['category'] === 'string' ? (p['category'] as string) : null,
        provider_invoice_ref: typeof p['provider_invoice_ref'] === 'string' ? (p['provider_invoice_ref'] as string) : null,
        provider_payment_ref: typeof p['provider_payment_ref'] === 'string' ? (p['provider_payment_ref'] as string) : null,
        provider_refund_ref: adj?.provider_object_ref ?? mine.find((c) => c.provider_object_ref !== null)?.provider_object_ref ?? null,
        currency: typeof p['currency'] === 'string' ? (p['currency'] as string) : null,
        amount_minor: typeof p['amount_minor'] === 'number' ? (p['amount_minor'] as number) : null,
        effective_at,
        accounting_period: accountingPeriodOf(effective_at),
        requested_by: r.requested_by,
        created_at: r.created_at,
        applied_at: r.applied_at ?? null,
      };
    });
    const last = page[page.length - 1];
    return { refunds, next_cursor: reqs.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id, filter) : null };
  }
}
