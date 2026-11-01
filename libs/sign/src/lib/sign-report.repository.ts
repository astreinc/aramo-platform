import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED) §1.13 — basic REPORTS for one
// organization. Read-only aggregates over sign."SignatureEnvelope"; every query is bound to
// the caller-supplied tenant_id (sign-service takes it ONLY from the verified auth context).
//
// Definitions (one set, used by the overview, the breakdowns and the CSV exports):
//   - the COHORT of a range = envelopes whose sent_at is in [from, to). Totals, completion
//     rate, turnaround and the by-sender / by-template breakdowns all describe the cohort;
//   - VOLUME counts each lifecycle event in the period it happened (sent_at, completed_at,
//     declined_at, voided_at), so a period's bars are independent of the envelope's later fate;
//   - TURNAROUND = completed_at − sent_at of the cohort's COMPLETED envelopes (seconds).
// Deleted drafts (deleted_at) are never counted. Aggregates carry no personal data; the
// envelope audit export reads the rows AFTER any executed purge has scrubbed them and the
// service masks purged subjects again (defence in depth), and recipient names / emails are
// never exported.

export type ReportPeriod = 'day' | 'week' | 'month';
export type ReportGroup = 'sender' | 'template';

export interface ReportRange {
  tenant_id: string;
  from: Date;
  to: Date;
}

export interface CohortStats {
  sent: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
  in_flight: number;
  turnaround_avg_seconds: number | null;
  turnaround_median_seconds: number | null;
  turnaround_p90_seconds: number | null;
}

export interface GroupedCohortStats extends CohortStats {
  // created_by (sender) or template_ref (template); null = envelopes not started from a template.
  key: string | null;
}

export interface VolumeBucket {
  period_start: Date;
  sent: number;
  completed: number;
  declined: number;
  voided: number;
}

export interface AuditEnvelopeRow {
  id: string;
  subject: string;
  status: string;
  created_by: string;
  source_application: string;
  template_ref: string | null;
  created_at: Date;
  sent_at: Date | null;
  completed_at: Date | null;
  declined_at: Date | null;
  voided_at: Date | null;
  recipients: number;
  signed: number;
  purge_state: string | null;
  purge_level: string | null;
  purge_executed_at: Date | null;
}

const PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month'];
// Whitelisted grouping columns (never interpolated from input).
const GROUP_COLUMN: Record<ReportGroup, string> = { sender: 'created_by::text', template: 'template_ref::text' };

const COHORT_SELECT = `
  count(*)::int AS sent,
  count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
  count(*) FILTER (WHERE status = 'DECLINED')::int AS declined,
  count(*) FILTER (WHERE status = 'VOIDED')::int AS voided,
  count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
  count(*) FILTER (WHERE status IN ('SENT', 'IN_PROGRESS'))::int AS in_flight,
  avg(extract(epoch FROM completed_at - sent_at)::float8) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL)::float8 AS turnaround_avg_seconds,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - sent_at)::float8) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL))::float8 AS turnaround_median_seconds,
  (percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - sent_at)::float8) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL))::float8 AS turnaround_p90_seconds`;

const COHORT_WHERE = `tenant_id = $1::uuid AND deleted_at IS NULL AND sent_at >= $2 AND sent_at < $3`;

type RawCohort = { [K in keyof CohortStats]: number | null };

function cohortOf(r: RawCohort | undefined): CohortStats {
  const n = (v: number | null | undefined): number => Number(v ?? 0);
  const f = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    sent: n(r?.sent),
    completed: n(r?.completed),
    declined: n(r?.declined),
    voided: n(r?.voided),
    expired: n(r?.expired),
    in_flight: n(r?.in_flight),
    turnaround_avg_seconds: f(r?.turnaround_avg_seconds),
    turnaround_median_seconds: f(r?.turnaround_median_seconds),
    turnaround_p90_seconds: f(r?.turnaround_p90_seconds),
  };
}

@Injectable()
export class SignReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The cohort totals (envelopes sent in the range). */
  async cohort(range: ReportRange): Promise<CohortStats> {
    const rows = await this.prisma.$queryRawUnsafe<RawCohort[]>(
      `SELECT ${COHORT_SELECT} FROM "sign"."SignatureEnvelope" WHERE ${COHORT_WHERE}`,
      range.tenant_id,
      range.from,
      range.to,
    );
    return cohortOf(rows[0]);
  }

  /** The cohort broken down by sender (created_by) or template (template_ref), most sent first. */
  async cohortBy(range: ReportRange, group: ReportGroup): Promise<GroupedCohortStats[]> {
    const column = GROUP_COLUMN[group];
    if (column === undefined) throw new Error(`unknown report group: ${String(group)}`);
    const rows = await this.prisma.$queryRawUnsafe<Array<RawCohort & { key: string | null }>>(
      `SELECT ${column} AS key, ${COHORT_SELECT} FROM "sign"."SignatureEnvelope" WHERE ${COHORT_WHERE} GROUP BY 1 ORDER BY 2 DESC, 1 ASC NULLS LAST`,
      range.tenant_id,
      range.from,
      range.to,
    );
    return rows.map((r) => ({ key: r.key, ...cohortOf(r) }));
  }

  /** Lifecycle events per UTC period (only periods with at least one event are returned). */
  async volume(range: ReportRange, period: ReportPeriod): Promise<VolumeBucket[]> {
    if (!PERIODS.includes(period)) throw new Error(`unknown report period: ${String(period)}`);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ bucket: Date; kind: string; n: number }>>(
      `SELECT (date_trunc($4, ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket, kind, count(*)::int AS n
         FROM (
           SELECT sent_at AS ts, 'sent' AS kind FROM "sign"."SignatureEnvelope"
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND sent_at >= $2 AND sent_at < $3
           UNION ALL
           SELECT completed_at, 'completed' FROM "sign"."SignatureEnvelope"
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND completed_at >= $2 AND completed_at < $3
           UNION ALL
           SELECT declined_at, 'declined' FROM "sign"."SignatureEnvelope"
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND declined_at >= $2 AND declined_at < $3
           UNION ALL
           SELECT voided_at, 'voided' FROM "sign"."SignatureEnvelope"
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND voided_at >= $2 AND voided_at < $3
         ) x
        GROUP BY 1, 2
        ORDER BY 1`,
      range.tenant_id,
      range.from,
      range.to,
      period,
    );
    const out = new Map<number, VolumeBucket>();
    for (const r of rows) {
      const at = new Date(r.bucket);
      const b = out.get(at.getTime()) ?? { period_start: at, sent: 0, completed: 0, declined: 0, voided: 0 };
      if (r.kind === 'sent' || r.kind === 'completed' || r.kind === 'declined' || r.kind === 'voided') b[r.kind] = Number(r.n);
      out.set(at.getTime(), b);
    }
    return [...out.values()].sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
  }

  /**
   * The envelope audit export: every envelope CREATED in the range (drafts included, deleted
   * drafts excluded), newest first, at most `limit` rows. Status and timestamps only, with
   * recipient COUNTS — never document contents, field values or recipient identities.
   */
  async auditEnvelopes(range: ReportRange, limit: number): Promise<AuditEnvelopeRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<AuditEnvelopeRow[]>(
      `SELECT e.id::text AS id, e.subject, e.status, e.created_by::text AS created_by, e.source_application,
              e.template_ref::text AS template_ref, e.created_at, e.sent_at, e.completed_at, e.declined_at, e.voided_at,
              (SELECT count(*)::int FROM "sign"."Signer" s WHERE s.envelope_id = e.id AND s.tenant_id = e.tenant_id) AS recipients,
              (SELECT count(*)::int FROM "sign"."Signer" s WHERE s.envelope_id = e.id AND s.tenant_id = e.tenant_id AND s.status = 'SIGNED') AS signed,
              e.purge_state, e.purge_level, e.purge_executed_at
         FROM "sign"."SignatureEnvelope" e
        WHERE e.tenant_id = $1::uuid AND e.deleted_at IS NULL AND e.created_at >= $2 AND e.created_at < $3
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $4`,
      range.tenant_id,
      range.from,
      range.to,
      limit,
    );
    return rows.map((r) => ({ ...r, recipients: Number(r.recipients), signed: Number(r.signed) }));
  }
}
