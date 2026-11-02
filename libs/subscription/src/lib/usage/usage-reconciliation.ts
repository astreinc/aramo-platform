import { createHash } from 'node:crypto';

// Sign usage metering — Amendment A3 (Aramo-Sign-Feature-Parity-Program-Directive-Amendment-A3-
// Metering-D1-D3-Ruling-v1_0-LOCKED, ad0f4b61…) "Invoice calculations must reconcile to
// authoritative recorded events" — the pure half of the billing-period reconciliation.
//
//   aggregateLedger      the period's billable events (UsageLedgerEntry rows) → per-unit lines
//                        (quantity, amount), the totals and a digest over every entry (id, unit,
//                        quantity, amount, in id order). The digest pins WHICH events a
//                        reconciliation covered, so a re-run can tell a replay from a change.
//   reconcileUsageLines  the ledger lines against the provider invoice's usage lines, per unit:
//                        MATCHED only when every unit's quantity AND amount are equal on both sides
//                        (a unit on one side only is a discrepancy). Never "close enough".
//   periodSegments       a SPLIT billing period (Remaining-Work Directive §3 B10): a plan change
//                        inside a period ends the subscription row and opens a new one on the same
//                        anchor, so the period's events sit on two (or more) rows, each priced at
//                        its own approved plan version. The period is reconciled ONCE over every
//                        segment that shares the period and the billing link, and recorded on the
//                        latest segment (the owner) — never per row against the one period invoice
//                        (which reported each half as a mismatch). Per-event prices need nothing
//                        more: each entry's amount is its own version's price, so the sums are exact.

export interface UsageLine {
  readonly unit_key: string;
  readonly quantity: number;
  readonly amount_minor: number;
}

export interface LedgerAggregate {
  readonly lines: readonly UsageLine[];
  readonly entry_count: number;
  readonly quantity_total: number;
  readonly amount_minor: number;
  readonly digest: string;
}

export interface UsageDiscrepancy {
  readonly unit_key: string;
  readonly ledger_quantity: number;
  readonly provider_quantity: number;
  readonly ledger_amount_minor: number;
  readonly provider_amount_minor: number;
}

export interface UsageReconciliationResult {
  readonly outcome: 'MATCHED' | 'MISMATCH';
  readonly discrepancies: readonly UsageDiscrepancy[];
}

const byUnit = (a: UsageLine, b: UsageLine): number => (a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0);

export function aggregateLedger(entries: readonly { id: string; unit_key: string; quantity: number; amount_minor: bigint | number }[]): LedgerAggregate {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const per = new Map<string, { quantity: number; amount: number }>();
  const hash = createHash('sha256');
  let quantity_total = 0;
  let amount = 0;
  for (const e of sorted) {
    const a = Number(e.amount_minor);
    if (!Number.isSafeInteger(a)) throw new Error(`ledger entry ${e.id}: amount is not a safe integer`);
    hash.update(`${e.id}|${e.unit_key}|${e.quantity}|${a}\n`, 'utf8');
    const cur = per.get(e.unit_key) ?? { quantity: 0, amount: 0 };
    per.set(e.unit_key, { quantity: cur.quantity + e.quantity, amount: cur.amount + a });
    quantity_total += e.quantity;
    amount += a;
  }
  const lines = [...per.entries()].map(([unit_key, v]) => ({ unit_key, quantity: v.quantity, amount_minor: v.amount })).sort(byUnit);
  return { lines, entry_count: sorted.length, quantity_total, amount_minor: amount, digest: hash.digest('hex') };
}

/** Sum duplicate unit lines and sort (a provider invoice may split one unit across lines). */
export function normalizeUsageLines(lines: readonly UsageLine[]): UsageLine[] {
  const per = new Map<string, { quantity: number; amount: number }>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 0 || !Number.isSafeInteger(l.amount_minor) || l.amount_minor < 0) {
      throw new Error(`usage line ${l.unit_key}: quantity and amount must be non-negative integers`);
    }
    const cur = per.get(l.unit_key) ?? { quantity: 0, amount: 0 };
    per.set(l.unit_key, { quantity: cur.quantity + l.quantity, amount: cur.amount + l.amount_minor });
  }
  return [...per.entries()].map(([unit_key, v]) => ({ unit_key, quantity: v.quantity, amount_minor: v.amount })).sort(byUnit);
}

export function reconcileUsageLines(ledger: readonly UsageLine[], provider: readonly UsageLine[]): UsageReconciliationResult {
  const l = new Map(normalizeUsageLines(ledger).map((x) => [x.unit_key, x]));
  const p = new Map(normalizeUsageLines(provider).map((x) => [x.unit_key, x]));
  const keys = [...new Set([...l.keys(), ...p.keys()])].sort();
  const discrepancies: UsageDiscrepancy[] = [];
  for (const unit_key of keys) {
    const a = l.get(unit_key);
    const b = p.get(unit_key);
    const d = {
      unit_key,
      ledger_quantity: a?.quantity ?? 0,
      provider_quantity: b?.quantity ?? 0,
      ledger_amount_minor: a?.amount_minor ?? 0,
      provider_amount_minor: b?.amount_minor ?? 0,
    };
    if (d.ledger_quantity !== d.provider_quantity || d.ledger_amount_minor !== d.provider_amount_minor) discrepancies.push(d);
  }
  return { outcome: discrepancies.length === 0 ? 'MATCHED' : 'MISMATCH', discrepancies };
}

export interface PeriodSegmentRow {
  readonly id: string;
  readonly period_anchor: Date;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly billing_provider: string | null;
  readonly billing_account_ref: string | null;
  readonly billing_subscription_ref: string | null;
}

export interface PeriodSegments {
  /** Every subscription row whose events belong to this period's reconciliation (id order). */
  readonly segment_ids: readonly string[];
  /** The row the reconciliation is recorded on: the latest-started segment (then the highest id). */
  readonly owner_id: string;
}

/**
 * The segments of one billing period. A row is a segment when it has the same billing link as
 * the subject (provider, account and provider subscription; null equals null), the same period
 * boundaries (its own anchor gives the same start and end) and a lifetime that overlaps the period.
 * The subject is always a segment.
 */
export function periodSegments(
  subject: PeriodSegmentRow,
  rows: readonly PeriodSegmentRow[],
  period: { start: Date; end: Date },
  periodOf: (anchor: Date, at: Date) => { start: Date; end: Date },
): PeriodSegments {
  const sameLink = (c: PeriodSegmentRow): boolean =>
    c.billing_provider === subject.billing_provider && c.billing_account_ref === subject.billing_account_ref && c.billing_subscription_ref === subject.billing_subscription_ref;
  const samePeriod = (c: PeriodSegmentRow): boolean => {
    const p = periodOf(c.period_anchor, period.start);
    return p.start.getTime() === period.start.getTime() && p.end.getTime() === period.end.getTime();
  };
  const overlaps = (c: PeriodSegmentRow): boolean =>
    c.started_at.getTime() < period.end.getTime() && (c.ended_at === null || c.ended_at.getTime() > period.start.getTime());
  const byId = new Map<string, PeriodSegmentRow>([[subject.id, subject]]);
  for (const c of rows) if (c.id !== subject.id && sameLink(c) && samePeriod(c) && overlaps(c)) byId.set(c.id, c);
  const segs = [...byId.values()];
  const owner = segs.reduce((a, b) => (b.started_at.getTime() > a.started_at.getTime() || (b.started_at.getTime() === a.started_at.getTime() && b.id > a.id) ? b : a));
  return { segment_ids: segs.map((x) => x.id).sort(), owner_id: owner.id };
}
