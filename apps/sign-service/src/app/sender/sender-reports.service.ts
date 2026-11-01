import { Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, IdentityRepository } from '@aramo/identity';
import { PURGED_TEXT, SignReportRepository, type CohortStats, type GroupedCohortStats, type ReportGroup, type ReportPeriod, type ReportRange } from '@aramo/sign';

import { SIGN_REPORTS_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

import { SenderContextService } from './sender-context.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED, 2bd74ca5) §1.13 — basic REPORTS
// (P1). Read-only, organization-wide, for one BUSINESS tenant:
//   - envelope volume by period (day / week / month, UTC);
//   - turnaround (sent → completed), completion rate;
//   - breakdowns by sender and by template (template_ref; template NAMES are not resolved
//     here — the Documents template library is a separate PR and this never depends on it);
//   - CSV export of each table, and an envelope AUDIT export (status and timestamps, with
//     recipient counts; never document contents, field values or recipient identities).
//
// Gates, in order, before any database read:
//   1. the plan capability `sign.reports` (NOT_AVAILABLE until the PO authorizes the flip —
//      directive R-8): ESIGN_FEATURE_NOT_AVAILABLE (403);
//   2. sign:report:read (also enforced by EsignSenderBoundary on every route);
//   3. a BUSINESS tenant (plans B+, §0/§1.13; Personal plans never get reports).
// tenant_id comes only from the verified auth context.
//
// Purge / redaction: aggregates carry no personal data. The audit export reads rows after an
// executed purge has scrubbed them, and additionally masks a purged subject (metadata level
// and above) and a redacted envelope's sender name, so a purge never leaks through a report.

export const REPORT_PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month'];
export const REPORT_EXPORTS = ['summary', 'volume', 'senders', 'templates'] as const;
export type ReportExport = (typeof REPORT_EXPORTS)[number];
// The longest range a report covers, and the longest a DAILY series covers.
export const REPORT_MAX_RANGE_DAYS = 731;
export const REPORT_MAX_DAILY_RANGE_DAYS = 366;
// The most envelopes one audit export returns (narrow the range for more).
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReportQuery {
  from?: string;
  to?: string;
  period?: string;
  report?: string;
}

export interface ResolvedRange extends ReportRange {
  // Inclusive calendar dates (UTC) as requested; `to` (the Date) is the exclusive end.
  from_date: string;
  to_date: string;
  period: ReportPeriod;
}

export interface ReportStatsView {
  sent: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
  in_flight: number;
  // Percent of the cohort that completed, one decimal; null when nothing was sent.
  completion_rate: number | null;
  turnaround_average_hours: number | null;
  turnaround_median_hours: number | null;
  turnaround_p90_hours: number | null;
}

export interface ReportsOverview {
  range: { from: string; to: string; period: ReportPeriod; timezone: 'UTC' };
  totals: ReportStatsView;
  volume: { period_start: string; sent: number; completed: number; declined: number; voided: number }[];
  by_sender: (ReportStatsView & { sender_id: string; sender_name: string | null })[];
  // template_ref null = envelopes not started from a template. template_name is reserved for
  // the template library (always null until it is wired; never guessed).
  by_template: (ReportStatsView & { template_ref: string | null; template_name: string | null })[];
}

export interface CsvExport {
  filename: string;
  body: string;
}

@Injectable()
export class SenderReportsService {
  constructor(
    private readonly reports: SignReportRepository,
    private readonly context: SenderContextService,
    private readonly identity: IdentityRepository,
    // Optional so tests can exercise both availability states; absent ⇒ the production registry.
    @Optional() private readonly features?: SignFeatureGate,
  ) {}

  /** True when the plan capability is available (the sender context's features.reports). */
  available(): boolean {
    return (this.features ?? new SignFeatureGate()).isAvailable(SIGN_REPORTS_FEATURE);
  }

  private async assertReportable(auth: AuthContextType, requestId: string): Promise<void> {
    (this.features ?? new SignFeatureGate()).assertAvailable(SIGN_REPORTS_FEATURE, requestId);
    if (!auth.scopes.includes(ESIGN_SCOPE.REPORT_READ)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Reports need the Sign Viewer or Sign Admin role', 403, {
        requestId,
        details: { missing_scopes: [ESIGN_SCOPE.REPORT_READ] },
      });
    }
    if ((await this.context.tenantKind(auth.tenant_id, requestId)) !== 'BUSINESS') {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Reports are part of the Business plans', 403, {
        requestId,
        details: { feature_key: SIGN_REPORTS_FEATURE, reason: 'business_plans_only' },
      });
    }
  }

  async overview(auth: AuthContextType, query: ReportQuery, requestId: string): Promise<ReportsOverview> {
    await this.assertReportable(auth, requestId);
    const range = resolveRange(auth.tenant_id, query, requestId);
    return this.build(range);
  }

  async exportCsv(auth: AuthContextType, query: ReportQuery, requestId: string): Promise<CsvExport> {
    await this.assertReportable(auth, requestId);
    const report = (query.report ?? 'summary') as ReportExport;
    if (!REPORT_EXPORTS.includes(report)) {
      throw invalid(requestId, 'report', `report must be one of ${REPORT_EXPORTS.join(', ')}`);
    }
    const range = resolveRange(auth.tenant_id, query, requestId);
    const o = await this.build(range);
    const stem = `aramo-sign-${report}-${range.from_date}-to-${range.to_date}`;
    const statsHead = ['sent', 'completed', 'declined', 'voided', 'expired', 'in_flight', 'completion_rate_percent', 'turnaround_average_hours', 'turnaround_median_hours', 'turnaround_p90_hours'];
    const statsCells = (s: ReportStatsView) => [s.sent, s.completed, s.declined, s.voided, s.expired, s.in_flight, s.completion_rate, s.turnaround_average_hours, s.turnaround_median_hours, s.turnaround_p90_hours];
    switch (report) {
      case 'volume':
        return {
          filename: `${stem}.csv`,
          body: toCsv(['period_start', 'sent', 'completed', 'declined', 'voided'], o.volume.map((v) => [v.period_start, v.sent, v.completed, v.declined, v.voided])),
        };
      case 'senders':
        return { filename: `${stem}.csv`, body: toCsv(['sender_id', 'sender_name', ...statsHead], o.by_sender.map((s) => [s.sender_id, s.sender_name, ...statsCells(s)])) };
      case 'templates':
        return { filename: `${stem}.csv`, body: toCsv(['template_ref', 'template_name', ...statsHead], o.by_template.map((t) => [t.template_ref, t.template_name, ...statsCells(t)])) };
      default:
        return { filename: `${stem}.csv`, body: toCsv(['from', 'to', ...statsHead], [[o.range.from, o.range.to, ...statsCells(o.totals)]]) };
    }
  }

  /** The envelope audit export (CSV): envelopes CREATED in the range, newest first. */
  async auditExport(auth: AuthContextType, query: ReportQuery, requestId: string): Promise<CsvExport> {
    await this.assertReportable(auth, requestId);
    const range = resolveRange(auth.tenant_id, query, requestId);
    const rows = await this.reports.auditEnvelopes(range, AUDIT_EXPORT_MAX_ROWS + 1);
    if (rows.length > AUDIT_EXPORT_MAX_ROWS) {
      throw new AramoError('VALIDATION_ERROR', `More than ${AUDIT_EXPORT_MAX_ROWS} envelopes in this range. Choose a shorter range.`, 400, {
        requestId,
        details: { reason: 'too_many_rows', max_rows: AUDIT_EXPORT_MAX_ROWS },
      });
    }
    const names = await this.userNames(rows.map((r) => r.created_by));
    const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
    const body = toCsv(
      ['envelope_id', 'subject', 'status', 'sender_id', 'sender_name', 'source_application', 'template_ref', 'created_at', 'sent_at', 'completed_at', 'declined_at', 'voided_at', 'recipients', 'signed', 'purge_state', 'purge_level', 'purge_executed_at'],
      rows.map((r) => {
        const executed = r.purge_state === 'EXECUTED';
        const metadataPurged = executed && (r.purge_level === 'DOCUMENTS_AND_METADATA' || r.purge_level === 'DOCUMENTS_AND_METADATA_AND_REDACT');
        const redacted = executed && r.purge_level === 'DOCUMENTS_AND_METADATA_AND_REDACT';
        return [
          r.id,
          metadataPurged ? PURGED_TEXT : r.subject,
          r.status,
          r.created_by,
          redacted ? null : (names.get(r.created_by) ?? null),
          r.source_application,
          r.template_ref,
          iso(r.created_at),
          iso(r.sent_at),
          iso(r.completed_at),
          iso(r.declined_at),
          iso(r.voided_at),
          r.recipients,
          r.signed,
          r.purge_state,
          r.purge_level,
          iso(r.purge_executed_at),
        ];
      }),
    );
    return { filename: `aramo-sign-envelope-audit-${range.from_date}-to-${range.to_date}.csv`, body };
  }

  private async build(range: ResolvedRange): Promise<ReportsOverview> {
    const [totals, senders, templates, volume] = await Promise.all([
      this.reports.cohort(range),
      this.reports.cohortBy(range, 'sender' satisfies ReportGroup),
      this.reports.cohortBy(range, 'template' satisfies ReportGroup),
      this.reports.volume(range, range.period),
    ]);
    const names = await this.userNames(senders.map((s) => s.key));
    const byStart = new Map(volume.map((v) => [dateOnly(v.period_start), v]));
    return {
      range: { from: range.from_date, to: range.to_date, period: range.period, timezone: 'UTC' },
      totals: statsView(totals),
      volume: periodStarts(range.from, range.to, range.period).map((start) => {
        const v = byStart.get(start);
        return { period_start: start, sent: v?.sent ?? 0, completed: v?.completed ?? 0, declined: v?.declined ?? 0, voided: v?.voided ?? 0 };
      }),
      by_sender: senders
        .filter((s): s is GroupedCohortStats & { key: string } => s.key !== null)
        .map((s) => ({ sender_id: s.key, sender_name: names.get(s.key) ?? null, ...statsView(s) })),
      by_template: templates.map((t) => ({ template_ref: t.key, template_name: null, ...statsView(t) })),
    };
  }

  // The organization member's display name (or email); null for an unknown / removed user.
  private async userNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids.filter((x): x is string => typeof x === 'string'))) {
      const u = await this.identity.findUserById(id).catch(() => null);
      if (u !== null) out.set(id, u.display_name ?? u.email);
    }
    return out;
  }
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

function invalid(requestId: string, field: string, message: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { field, reason: 'invalid_report_query' } });
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(v: string, field: string, requestId: string): Date {
  if (!DATE_RE.test(v)) throw invalid(requestId, field, `${field} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || dateOnly(d) !== v) throw invalid(requestId, field, `${field} is not a valid date`);
  return d;
}

/**
 * The report range: `from` and `to` are inclusive UTC calendar dates (YYYY-MM-DD). Defaults:
 * `to` = today, `from` = the first day of the month five months before `to` (six calendar
 * months, as the dashboard shows), period = month.
 */
export function resolveRange(tenant_id: string, q: ReportQuery, requestId: string, now: Date = new Date()): ResolvedRange {
  const period = (q.period ?? 'month') as ReportPeriod;
  if (!REPORT_PERIODS.includes(period)) throw invalid(requestId, 'period', 'period must be day, week or month');
  const toDay = q.to !== undefined && q.to !== '' ? parseDate(q.to, 'to', requestId) : new Date(`${dateOnly(now)}T00:00:00.000Z`);
  const fromDay =
    q.from !== undefined && q.from !== ''
      ? parseDate(q.from, 'from', requestId)
      : new Date(Date.UTC(toDay.getUTCFullYear(), toDay.getUTCMonth() - 5, 1));
  if (fromDay.getTime() > toDay.getTime()) throw invalid(requestId, 'from', 'from must be on or before to');
  const end = new Date(toDay.getTime() + DAY_MS);
  const days = Math.round((end.getTime() - fromDay.getTime()) / DAY_MS);
  if (days > REPORT_MAX_RANGE_DAYS) throw invalid(requestId, 'from', `A report covers at most ${REPORT_MAX_RANGE_DAYS} days`);
  if (period === 'day' && days > REPORT_MAX_DAILY_RANGE_DAYS) throw invalid(requestId, 'period', `A daily report covers at most ${REPORT_MAX_DAILY_RANGE_DAYS} days`);
  return { tenant_id, from: fromDay, to: end, from_date: dateOnly(fromDay), to_date: dateOnly(toDay), period };
}

/** Every period start (UTC, as Postgres date_trunc computes it; weeks start Monday) in [from, to). */
export function periodStarts(from: Date, to: Date, period: ReportPeriod): string[] {
  const out: string[] = [];
  let d: Date;
  if (period === 'month') d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  else if (period === 'week') d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - ((from.getUTCDay() + 6) % 7)));
  else d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (d.getTime() < to.getTime()) {
    out.push(dateOnly(d));
    if (period === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    else d = new Date(d.getTime() + (period === 'week' ? 7 : 1) * DAY_MS);
  }
  return out;
}

const hours = (s: number | null): number | null => (s === null ? null : Math.round((s / 3600) * 10) / 10);

export function statsView(s: CohortStats): ReportStatsView {
  return {
    sent: s.sent,
    completed: s.completed,
    declined: s.declined,
    voided: s.voided,
    expired: s.expired,
    in_flight: s.in_flight,
    completion_rate: s.sent === 0 ? null : Math.round((s.completed / s.sent) * 1000) / 10,
    turnaround_average_hours: hours(s.turnaround_avg_seconds),
    turnaround_median_hours: hours(s.turnaround_median_seconds),
    turnaround_p90_hours: hours(s.turnaround_p90_seconds),
  };
}

// RFC 4180 CSV. A text cell that a spreadsheet would read as a formula (= + - @, tab, CR) is
// prefixed with an apostrophe (CSV injection guard); numbers are written as numbers.
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(head: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return [head, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}
