import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { Prisma } from '../../../prisma/generated/client/client.js';
import { BILLING_COMMAND_STATES } from '../billing/billing-provider-command.js';
import { BILLING_WEBHOOK_INBOX_STATUSES } from '../billing/billing-webhook-inbox.service.js';
import { GOVERNED_SUBSCRIPTION_OPEN } from '../billing/governed-subscription.js';
import { COMMERCIAL_CHANGE_REQUEST_STATES, isApplyExpirable } from '../commercial/commercial-change-request.js';
import { parseActiveCommercialPolicy } from '../commercial/commercial-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';

import {
  CCP_ALERT_RAISED_EVENT,
  CCP_ALERT_RESOLVED_EVENT,
  CCP_ALERT_SCAN_EVENT,
  COMMERCIAL_ALERT_DEFINITIONS,
  COMMERCIAL_ALERT_STATUSES,
  type CommercialAlertFamily,
  type CommercialAlertStatus,
  type CommercialAlertThresholds,
  type CommercialAlertType,
  type DetectedCondition,
  commercialAlertThresholds,
  commercialAlertTypesOf,
  diffAlerts,
} from './commercial-alert.js';

// CCP-D3 (PBD §5.4 row D3) — the alert scanner, the exception register reads and the
// counts-and-states metrics.
//
//   scan      ONE transaction under a try-advisory lock (a second concurrent scan skips): read every
//             source, diff against the OPEN alerts, raise / refresh / resolve, then log one JSON line
//             per raise and per resolve and one summary line. READ-ONLY on every source table: the
//             scanner writes CommercialOperationalAlert only. A source that could not be read in
//             full (absent, or more rows than the per-source cap) never resolves its open alerts.
//   list      the register for one family (the route's scope decides the family), newest first,
//             keyset cursor pinned to the filter set.
//   metrics   counts by state, for the whole platform. Never per tenant, never money, no grade.
//
// The D1 source (USAGE_NOT_RECONCILED) reads the latest subscription."UsageRollupRun" per metric by
// raw SQL, guarded by to_regclass: CCP-D1 is not an ancestor of this slice's baseline (pre-execution
// D3-C4), so the scanner neither imports D1 code nor fails when the table is absent.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export const COMMERCIAL_ALERT_SCAN_LOCK = 'ccp-d3:alert-scan';
/** Per-source read cap; a source at the cap is "truncated" and resolves nothing in that scan. */
export const COMMERCIAL_ALERT_SOURCE_CAP = 1000;

export interface CommercialAlertRow {
  id: string;
  alert_type: string;
  family: string;
  subject_kind: string;
  subject_id: string;
  tenant_id: string | null;
  product_key: string | null;
  status: string;
  detail: string;
  evidence: unknown;
  threshold_minutes: number | null;
  detection_count: number;
  first_detected_at: Date;
  last_detected_at: Date;
  resolved_at: Date | null;
  resolution_detail: string | null;
  updated_at: Date;
}

export type CommercialAlertSourceState = 'read' | 'truncated' | 'unavailable';

export interface CommercialAlertScanTally {
  skipped?: 'LOCKED';
  at: Date;
  raised: number;
  refreshed: number;
  resolved: number;
  open: number;
  sources: Record<CommercialAlertType, CommercialAlertSourceState>;
  thresholds: CommercialAlertThresholds;
  raised_alerts: CommercialAlertRow[];
  resolved_alerts: CommercialAlertRow[];
}

export interface CommercialAlertListQuery {
  status?: CommercialAlertStatus;
  alert_type?: string;
  tenant_id?: string;
  limit?: number;
  cursor?: string;
}

export class CommercialAlertQueryError extends Error {
  constructor(
    readonly code: 'INVALID_CURSOR' | 'INVALID_QUERY',
    message: string,
  ) {
    super(message);
    this.name = 'CommercialAlertQueryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(row: { first_detected_at: Date; id: string }, filter: string): string {
  return Buffer.from(JSON.stringify({ c: row.first_detected_at.toISOString(), i: row.id, f: filter }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, filter: string): { at: Date; id: string } {
  let v: { c?: unknown; i?: unknown; f?: unknown };
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown; f?: unknown };
  } catch {
    throw new CommercialAlertQueryError('INVALID_CURSOR', 'malformed cursor');
  }
  const at = typeof v.c === 'string' ? new Date(v.c) : null;
  if (at === null || Number.isNaN(at.getTime()) || typeof v.i !== 'string' || !UUID.test(v.i)) throw new CommercialAlertQueryError('INVALID_CURSOR', 'malformed cursor');
  if (v.f !== filter) throw new CommercialAlertQueryError('INVALID_CURSOR', 'cursor filters do not match the current query');
  return { at, id: v.i };
}

const iso = (d: Date | null | undefined): string | null => (d === null || d === undefined ? null : d.toISOString());
/** The apply deadline an APPLY_DEADLINE_* alert recorded in its evidence (null when absent or malformed). */
function applyDeadlineIn(evidence: unknown): Date | null {
  const v = (evidence as Record<string, unknown> | null)?.['apply_deadline'];
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const minutesBetween = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / 60_000);

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export interface BillingOperationsMetrics {
  as_of: Date;
  commands_by_state: Record<string, number>;
  commands_pending_provider_past_threshold: number;
  webhook_inbox_by_status: Record<string, number>;
  open_reconciliation_flags_by_reason: Record<string, number>;
  open_alerts_by_type: Record<string, number>;
  thresholds: CommercialAlertThresholds;
}

export interface ApprovalOperationsMetrics {
  as_of: Date;
  change_requests_by_state: Record<string, number>;
  pending_approval_nearing_expiry: number;
  pending_approval_past_expiry: number;
  open_alerts_by_type: Record<string, number>;
  thresholds: CommercialAlertThresholds;
}

@Injectable()
export class CommercialAlertService {
  private readonly log = new Logger('CommercialAlertScanner');

  constructor(private readonly prisma: PrismaService) {}

  // ---- the scan ---------------------------------------------------------------------------------

  async scan(at: Date, thresholds: CommercialAlertThresholds = commercialAlertThresholds()): Promise<CommercialAlertScanTally> {
    const sources = Object.fromEntries(Object.keys(COMMERCIAL_ALERT_DEFINITIONS).map((t) => [t, 'read'])) as Record<CommercialAlertType, CommercialAlertSourceState>;
    const tally: CommercialAlertScanTally = await this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${COMMERCIAL_ALERT_SCAN_LOCK}, 0)) AS ok`;
        if (lock[0]?.ok !== true) {
          return { skipped: 'LOCKED' as const, at, raised: 0, refreshed: 0, resolved: 0, open: 0, sources, thresholds, raised_alerts: [], resolved_alerts: [] };
        }
        const detected = await this.detect(tx, at, thresholds, sources);
        const open = (await tx.commercialOperationalAlert.findMany({ where: { status: 'OPEN' } })) as CommercialAlertRow[];
        const unread = new Set(Object.entries(sources).filter(([, s]) => s !== 'read').map(([t]) => t));
        const diff = diffAlerts(open, detected, unread);

        const raised_alerts: CommercialAlertRow[] = [];
        for (const c of diff.raise) {
          const def = COMMERCIAL_ALERT_DEFINITIONS[c.alert_type];
          raised_alerts.push(
            (await tx.commercialOperationalAlert.create({
              data: {
                id: uuidv7(),
                alert_type: c.alert_type,
                family: def.family,
                subject_kind: def.subject_kind,
                subject_id: c.subject_id,
                tenant_id: c.tenant_id,
                product_key: c.product_key,
                status: 'OPEN',
                detail: c.detail,
                evidence: c.evidence as Prisma.InputJsonValue,
                threshold_minutes: c.threshold_minutes,
                detection_count: 1,
                first_detected_at: at,
                last_detected_at: at,
                updated_at: at,
              },
            })) as CommercialAlertRow,
          );
        }
        for (const { open: o, condition: c } of diff.refresh) {
          await tx.commercialOperationalAlert.update({
            where: { id: o.id },
            data: {
              detail: c.detail,
              evidence: c.evidence as Prisma.InputJsonValue,
              threshold_minutes: c.threshold_minutes,
              detection_count: { increment: 1 },
              last_detected_at: at < o.last_detected_at ? o.last_detected_at : at,
              updated_at: at,
            },
          });
        }
        const resolutions = await this.resolutionDetails(tx, diff.resolve, at, thresholds);
        const resolved_alerts: CommercialAlertRow[] = [];
        for (const o of diff.resolve) {
          resolved_alerts.push(
            (await tx.commercialOperationalAlert.update({
              where: { id: o.id },
              data: { status: 'RESOLVED', resolved_at: at < o.first_detected_at ? o.first_detected_at : at, resolution_detail: resolutions.get(o.id) ?? 'condition no longer observed', updated_at: at },
            })) as CommercialAlertRow,
          );
        }
        const openCount = await tx.commercialOperationalAlert.count({ where: { status: 'OPEN' } });
        return { at, raised: raised_alerts.length, refreshed: diff.refresh.length, resolved: resolved_alerts.length, open: openCount, sources, thresholds, raised_alerts, resolved_alerts };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    // After commit: the structured log events (ids, types and states only; never a payload).
    for (const a of tally.raised_alerts) {
      this.log.warn(JSON.stringify({ event: CCP_ALERT_RAISED_EVENT, alert_id: a.id, alert_type: a.alert_type, family: a.family, subject_kind: a.subject_kind, subject_id: a.subject_id, tenant_id: a.tenant_id, product_key: a.product_key, detail: a.detail, at: at.toISOString() }));
    }
    for (const a of tally.resolved_alerts) {
      this.log.log(JSON.stringify({ event: CCP_ALERT_RESOLVED_EVENT, alert_id: a.id, alert_type: a.alert_type, family: a.family, subject_kind: a.subject_kind, subject_id: a.subject_id, resolution: a.resolution_detail, at: at.toISOString() }));
    }
    this.log.log(
      JSON.stringify({
        event: CCP_ALERT_SCAN_EVENT,
        ...(tally.skipped !== undefined ? { skipped: tally.skipped } : {}),
        raised: tally.raised,
        refreshed: tally.refreshed,
        resolved: tally.resolved,
        open: tally.open,
        unread_sources: Object.entries(tally.sources).filter(([, s]) => s !== 'read').map(([t, s]) => `${t}:${s}`),
        at: at.toISOString(),
      }),
    );
    return tally;
  }

  /** Every source, read-only. Marks a source `truncated` at the cap and `unavailable` when absent. */
  private async detect(tx: Tx, at: Date, th: CommercialAlertThresholds, sources: Record<CommercialAlertType, CommercialAlertSourceState>): Promise<DetectedCondition[]> {
    const out: DetectedCondition[] = [];
    const cap = COMMERCIAL_ALERT_SOURCE_CAP;
    const capped = <T>(type: CommercialAlertType, rows: T[]): T[] => {
      if (rows.length > cap) {
        sources[type] = 'truncated';
        return rows.slice(0, cap);
      }
      return rows;
    };

    // COMMAND_PENDING_PROVIDER_STUCK — accepted by the provider, never confirmed, for >= threshold.
    const stuckBefore = new Date(at.getTime() - th.pending_provider_stuck_minutes * 60_000);
    const stuck = capped(
      'COMMAND_PENDING_PROVIDER_STUCK',
      await tx.billingProviderCommand.findMany({
        where: { state: 'PENDING_PROVIDER', OR: [{ provider_accepted_at: { lte: stuckBefore } }, { provider_accepted_at: null, updated_at: { lte: stuckBefore } }] },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: cap + 1,
      }),
    );
    for (const c of stuck) {
      const since = c.provider_accepted_at ?? c.updated_at;
      out.push({
        alert_type: 'COMMAND_PENDING_PROVIDER_STUCK',
        subject_id: c.id,
        tenant_id: c.tenant_id,
        product_key: c.product_key,
        detail: `${c.command_kind} accepted by the provider ${minutesBetween(since, at)} min ago and not yet confirmed (threshold ${th.pending_provider_stuck_minutes} min)`,
        evidence: { state: c.state, command_kind: c.command_kind, change_request_id: c.change_request_id, target_ref: c.target_ref, attempts: c.attempts, provider_accepted_at: iso(c.provider_accepted_at), minutes_pending: minutesBetween(since, at) },
        threshold_minutes: th.pending_provider_stuck_minutes,
      });
    }

    // COMMAND_FAILED
    const failed = capped('COMMAND_FAILED', await tx.billingProviderCommand.findMany({ where: { state: 'FAILED' }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: cap + 1 }));
    for (const c of failed) {
      out.push({
        alert_type: 'COMMAND_FAILED',
        subject_id: c.id,
        tenant_id: c.tenant_id,
        product_key: c.product_key,
        detail: `${c.command_kind} FAILED ${c.last_error_code ?? 'UNKNOWN'} after ${c.attempts} attempt(s)`,
        evidence: { state: c.state, command_kind: c.command_kind, change_request_id: c.change_request_id, target_ref: c.target_ref, attempts: c.attempts, failure_code: c.last_error_code, failed_at: iso(c.failed_at) },
        threshold_minutes: null,
      });
    }

    // HELD_ACTIVATION — open governed_subscription_open flags (product via the held intent's plan).
    const held = capped(
      'HELD_ACTIVATION',
      await tx.$queryRaw<Array<{ id: string; tenant_id: string; provider: string; subscription_ref: string; intent_id: string | null; detected_at: Date; product_key: string | null }>>`
        SELECT f.id::text AS id, f.tenant_id::text AS tenant_id, f.provider, f.subscription_ref, f.intent_id::text AS intent_id, f.detected_at, p.product_key
          FROM subscription."BillingReconciliationFlag" f
          LEFT JOIN subscription."CheckoutIntent" ci ON ci.id = f.intent_id
          LEFT JOIN subscription."Plan" p ON p.id = ci.plan_id
         WHERE f.reason = ${GOVERNED_SUBSCRIPTION_OPEN} AND f.resolved_at IS NULL
         ORDER BY f.detected_at ASC, f.id ASC
         LIMIT ${cap + 1}`,
    );
    for (const f of held) {
      out.push({
        alert_type: 'HELD_ACTIVATION',
        subject_id: f.id,
        tenant_id: f.tenant_id,
        product_key: f.product_key,
        detail: `self-service activation held: a governed subscription is open (flag open ${minutesBetween(f.detected_at, at)} min)`,
        evidence: { reason: GOVERNED_SUBSCRIPTION_OPEN, provider: f.provider, subscription_ref: f.subscription_ref, intent_id: f.intent_id, detected_at: iso(f.detected_at) },
        threshold_minutes: null,
      });
    }

    // WEBHOOK_INBOX_FAILED
    const inbox = capped('WEBHOOK_INBOX_FAILED', await tx.billingWebhookInbox.findMany({ where: { status: 'FAILED' }, orderBy: [{ received_at: 'asc' }, { id: 'asc' }], take: cap + 1 }));
    for (const e of inbox) {
      out.push({
        alert_type: 'WEBHOOK_INBOX_FAILED',
        subject_id: e.id,
        tenant_id: null,
        product_key: e.product_key,
        detail: `provider event ${e.event_type} failed processing after ${e.attempts} attempt(s)`,
        evidence: { status: e.status, provider: e.provider, provider_event_id: e.provider_event_id, event_type: e.event_type, attempts: e.attempts, next_attempt_at: iso(e.next_attempt_at), last_error: e.last_error },
        threshold_minutes: null,
      });
    }

    // USAGE_NOT_RECONCILED — the latest CCP-D1 run per metric (absent table: unavailable).
    const present = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('subscription."UsageRollupRun"') IS NOT NULL AS present`;
    if (present[0]?.present !== true) {
      sources.USAGE_NOT_RECONCILED = 'unavailable';
    } else {
      const runs = await tx.$queryRawUnsafe<Array<{ id: string; metric_key: string; mode: string; reconciliation: string; mismatch_count: number; pending_bucket_count: number; finished_at: Date }>>(
        `SELECT DISTINCT ON (r.metric_key) r.id::text AS id, r.metric_key, r.mode, r.reconciliation, r.mismatch_count, r.pending_bucket_count, r.finished_at
           FROM subscription."UsageRollupRun" r
          ORDER BY r.metric_key, r.started_at DESC, r.id DESC`,
      );
      for (const r of runs) {
        if (r.reconciliation !== 'NOT_RECONCILED') continue;
        out.push({
          alert_type: 'USAGE_NOT_RECONCILED',
          subject_id: r.metric_key,
          tenant_id: null,
          product_key: r.metric_key.split('.')[0] ?? null,
          detail: `latest usage roll-up run (${r.mode}) did not reconcile: ${r.mismatch_count} mismatch(es)`,
          evidence: { run_id: r.id, mode: r.mode, reconciliation: r.reconciliation, mismatch_count: r.mismatch_count, pending_bucket_count: r.pending_bucket_count, finished_at: iso(r.finished_at) },
          threshold_minutes: null,
        });
      }
    }

    // APPLY_FAILED
    const applyFailed = capped(
      'APPLY_FAILED',
      await tx.commercialChangeRequest.findMany({
        where: { state: 'APPLY_FAILED' },
        select: { id: true, action_type: true, tenant_id: true, product_key: true, apply_attempts: true, updated_at: true },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: cap + 1,
      }),
    );
    for (const r of applyFailed) {
      out.push({
        alert_type: 'APPLY_FAILED',
        subject_id: r.id,
        tenant_id: r.tenant_id,
        product_key: r.product_key,
        detail: `${r.action_type} apply failed after ${r.apply_attempts} attempt(s); retryable`,
        evidence: { state: 'APPLY_FAILED', action_type: r.action_type, apply_attempts: r.apply_attempts, updated_at: iso(r.updated_at) },
        threshold_minutes: null,
      });
    }

    // APPROVAL_NEARING_EXPIRY / APPROVAL_PAST_EXPIRY — PENDING_APPROVAL by expires_at.
    const leadUntil = new Date(at.getTime() + th.approval_expiry_lead_minutes * 60_000);
    const pendingSelect = { id: true, action_type: true, tenant_id: true, product_key: true, expires_at: true, submitted_at: true } as const;
    const nearing = capped(
      'APPROVAL_NEARING_EXPIRY',
      await tx.commercialChangeRequest.findMany({ where: { state: 'PENDING_APPROVAL', expires_at: { gt: at, lte: leadUntil } }, select: pendingSelect, orderBy: [{ expires_at: 'asc' }, { id: 'asc' }], take: cap + 1 }),
    );
    for (const r of nearing) {
      const expires = r.expires_at as Date;
      out.push({
        alert_type: 'APPROVAL_NEARING_EXPIRY',
        subject_id: r.id,
        tenant_id: r.tenant_id,
        product_key: r.product_key,
        detail: `${r.action_type} awaiting approval expires in ${Math.ceil((expires.getTime() - at.getTime()) / 60_000)} min (lead ${th.approval_expiry_lead_minutes} min)`,
        evidence: { state: 'PENDING_APPROVAL', action_type: r.action_type, submitted_at: iso(r.submitted_at), expires_at: iso(expires) },
        threshold_minutes: th.approval_expiry_lead_minutes,
      });
    }
    const past = capped(
      'APPROVAL_PAST_EXPIRY',
      await tx.commercialChangeRequest.findMany({ where: { state: 'PENDING_APPROVAL', expires_at: { lte: at } }, select: pendingSelect, orderBy: [{ expires_at: 'asc' }, { id: 'asc' }], take: cap + 1 }),
    );
    for (const r of past) {
      const expires = r.expires_at as Date;
      out.push({
        alert_type: 'APPROVAL_PAST_EXPIRY',
        subject_id: r.id,
        tenant_id: r.tenant_id,
        product_key: r.product_key,
        detail: `${r.action_type} still PENDING_APPROVAL ${minutesBetween(expires, at)} min after its expiry (no further approval is accepted)`,
        evidence: { state: 'PENDING_APPROVAL', action_type: r.action_type, submitted_at: iso(r.submitted_at), expires_at: iso(expires) },
        threshold_minutes: null,
      });
    }

    // APPLY_DEADLINE_NEARING / APPLY_DEADLINE_PASSED (CCP-FIX1, closes TD-D3-10) — APPROVED or
    // APPLY_FAILED requests whose SNAPSHOTTED policy version declares apply_expiry_hours (AD-1, AD-2).
    // The deadline is computed exactly as CommercialChangeRequestService.applyDeadlineOf computes it:
    // final approval + the snapshotted version's apply_expiry_hours, the version read through the
    // strict parser and its checksum equal to the request's snapshot. A request under a version
    // without the key (v1) has no deadline and is never alerted; a snapshot that cannot be read or
    // does not match is not alerted here (its apply is refused INTEGRITY). Half-open (AD-3): at the
    // deadline it has passed. Never APPLYING (AD-4). Both types share one source (and one cap).
    const deadlineRows = await tx.commercialChangeRequest.findMany({
      where: { state: { in: ['APPROVED', 'APPLY_FAILED'] }, approved_at: { not: null } },
      select: { id: true, action_type: true, kind: true, state: true, tenant_id: true, product_key: true, approved_at: true, policy_version_id: true, policy_checksum: true },
      orderBy: [{ approved_at: 'asc' }, { id: 'asc' }],
      take: cap + 1,
    });
    if (deadlineRows.length > cap) {
      sources.APPLY_DEADLINE_NEARING = 'truncated';
      sources.APPLY_DEADLINE_PASSED = 'truncated';
    }
    const expirable = deadlineRows.slice(0, cap).filter((r) => isApplyExpirable(r.action_type, r.kind));
    const versionIds = [...new Set(expirable.map((r) => r.policy_version_id))];
    const versions = new Map((await tx.commercialPolicyVersion.findMany({ where: { id: { in: versionIds } } })).map((v) => [v.id, v]));
    const hoursOf = new Map<string, { hours: number | undefined; checksum: string } | null>();
    for (const id of versionIds) {
      const v = versions.get(id);
      try {
        if (v === undefined || v.status === 'DRAFT') throw new Error('unreadable');
        const p = parseActiveCommercialPolicy({ ...v, status: 'ACTIVE' });
        hoursOf.set(id, { hours: p.content.apply_expiry_hours, checksum: p.checksum });
      } catch {
        hoursOf.set(id, null);
      }
    }
    const applyLeadUntil = at.getTime() + th.approval_expiry_lead_minutes * 60_000;
    for (const r of expirable) {
      const snap = hoursOf.get(r.policy_version_id);
      if (snap === null || snap === undefined || snap.hours === undefined || snap.checksum !== r.policy_checksum) continue;
      const approved = r.approved_at as Date;
      const deadline = new Date(approved.getTime() + snap.hours * 3_600_000);
      const evidence = {
        state: r.state,
        action_type: r.action_type,
        final_approved_at: iso(approved),
        apply_deadline: iso(deadline),
        apply_expiry_hours: snap.hours,
        policy_version_id: r.policy_version_id,
      };
      if (deadline.getTime() <= at.getTime()) {
        out.push({
          alert_type: 'APPLY_DEADLINE_PASSED',
          subject_id: r.id,
          tenant_id: r.tenant_id,
          product_key: r.product_key,
          detail: `${r.action_type} still ${r.state} ${minutesBetween(deadline, at)} min after its apply deadline (apply authority has expired; a fresh request is needed)`,
          evidence,
          threshold_minutes: null,
        });
      } else if (deadline.getTime() <= applyLeadUntil) {
        out.push({
          alert_type: 'APPLY_DEADLINE_NEARING',
          subject_id: r.id,
          tenant_id: r.tenant_id,
          product_key: r.product_key,
          detail: `${r.action_type} ${r.state} must be applied within ${Math.ceil((deadline.getTime() - at.getTime()) / 60_000)} min (lead ${th.approval_expiry_lead_minutes} min)`,
          evidence,
          threshold_minutes: th.approval_expiry_lead_minutes,
        });
      }
    }
    return out;
  }

  /** What the subject became, for each alert being resolved (read-only lookups). */
  private async resolutionDetails(tx: Tx, alerts: readonly CommercialAlertRow[], at: Date, th: CommercialAlertThresholds): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // Every lookup kind below is uuid-keyed; a non-uuid subject id simply has no current row.
    const ids = (kind: string) => [...new Set(alerts.filter((a) => a.subject_kind === kind && UUID.test(a.subject_id)).map((a) => a.subject_id))];
    const commands = new Map((await tx.billingProviderCommand.findMany({ where: { id: { in: ids('billing_command') } }, select: { id: true, state: true } })).map((c) => [c.id, c.state]));
    const requests = new Map((await tx.commercialChangeRequest.findMany({ where: { id: { in: ids('change_request') } }, select: { id: true, state: true, expires_at: true } })).map((r) => [r.id, r]));
    const flags = new Map((await tx.billingReconciliationFlag.findMany({ where: { id: { in: ids('reconciliation_flag') } }, select: { id: true, resolved_at: true } })).map((f) => [f.id, f.resolved_at]));
    const inbox = new Map((await tx.billingWebhookInbox.findMany({ where: { id: { in: ids('webhook_inbox') } }, select: { id: true, status: true, outcome: true } })).map((e) => [e.id, e]));
    for (const a of alerts) {
      let d: string;
      switch (a.subject_kind) {
        case 'billing_command': {
          const s = commands.get(a.subject_id);
          d = s === undefined ? 'command no longer present' : `command state now ${s}`;
          break;
        }
        case 'change_request': {
          const r = requests.get(a.subject_id);
          if (r === undefined) d = 'change request no longer present';
          else if (a.alert_type === 'APPROVAL_NEARING_EXPIRY' && r.state === 'PENDING_APPROVAL' && r.expires_at !== null && r.expires_at <= at) d = 'expiry reached (see APPROVAL_PAST_EXPIRY)';
          else if (a.alert_type === 'APPROVAL_NEARING_EXPIRY' && r.state === 'PENDING_APPROVAL') d = `no longer within the ${th.approval_expiry_lead_minutes} min lead`;
          else if (a.alert_type === 'APPLY_DEADLINE_NEARING' && (r.state === 'APPROVED' || r.state === 'APPLY_FAILED') && applyDeadlineIn(a.evidence) !== null && (applyDeadlineIn(a.evidence) as Date) <= at) d = 'apply deadline reached (see APPLY_DEADLINE_PASSED)';
          else d = `change request state now ${r.state}`;
          break;
        }
        case 'reconciliation_flag': {
          const r = flags.get(a.subject_id);
          d = r === undefined ? 'flag no longer present' : r === null ? 'flag no longer held' : `flag resolved at ${r.toISOString()}`;
          break;
        }
        case 'webhook_inbox': {
          const e = inbox.get(a.subject_id);
          d = e === undefined ? 'inbox row no longer present' : `inbox status now ${e.status}${e.outcome !== null ? ` (${e.outcome})` : ''}`;
          break;
        }
        case 'usage_metric':
          d = 'latest usage roll-up run reconciled';
          break;
        default:
          d = 'condition no longer observed';
      }
      out.set(a.id, d);
    }
    return out;
  }

  // ---- the register reads -----------------------------------------------------------------------

  async list(family: CommercialAlertFamily, q: CommercialAlertListQuery): Promise<{ alerts: CommercialAlertRow[]; next_cursor: string | null }> {
    const types = commercialAlertTypesOf(family);
    if (q.status !== undefined && !(COMMERCIAL_ALERT_STATUSES as readonly string[]).includes(q.status)) throw new CommercialAlertQueryError('INVALID_QUERY', 'unknown status');
    if (q.alert_type !== undefined && !(types as string[]).includes(q.alert_type)) throw new CommercialAlertQueryError('INVALID_QUERY', `alert_type must be one of ${types.join(', ')}`);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const filter = JSON.stringify([family, q.status ?? null, q.alert_type ?? null, q.tenant_id ?? null]);
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor, filter);
    const where: Prisma.CommercialOperationalAlertWhereInput = {
      family,
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.alert_type !== undefined ? { alert_type: q.alert_type } : {}),
      ...(q.tenant_id !== undefined ? { tenant_id: q.tenant_id } : {}),
      ...(after !== null ? { OR: [{ first_detected_at: { lt: after.at } }, { first_detected_at: after.at, id: { lt: after.id } }] } : {}),
    };
    const rows = (await this.prisma.commercialOperationalAlert.findMany({ where, orderBy: [{ first_detected_at: 'desc' }, { id: 'desc' }], take: limit + 1 })) as CommercialAlertRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { alerts: page, next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last, filter) : null };
  }

  private async openAlertsByType(family: CommercialAlertFamily): Promise<Record<string, number>> {
    const counts = zeroCounts(commercialAlertTypesOf(family));
    const g = await this.prisma.commercialOperationalAlert.groupBy({ by: ['alert_type'], where: { family, status: 'OPEN' }, _count: { _all: true } });
    for (const r of g) counts[r.alert_type as CommercialAlertType] = r._count._all;
    return counts;
  }

  // ---- metrics: counts by state only ------------------------------------------------------------

  async billingMetrics(at: Date, thresholds: CommercialAlertThresholds = commercialAlertThresholds()): Promise<BillingOperationsMetrics> {
    const commands = zeroCounts(BILLING_COMMAND_STATES);
    for (const r of await this.prisma.billingProviderCommand.groupBy({ by: ['state'], _count: { _all: true } })) commands[r.state as keyof typeof commands] = r._count._all;
    const inbox = zeroCounts(BILLING_WEBHOOK_INBOX_STATUSES);
    for (const r of await this.prisma.billingWebhookInbox.groupBy({ by: ['status'], _count: { _all: true } })) inbox[r.status as keyof typeof inbox] = r._count._all;
    const flags: Record<string, number> = {};
    for (const r of await this.prisma.billingReconciliationFlag.groupBy({ by: ['reason'], where: { resolved_at: null }, _count: { _all: true }, orderBy: { reason: 'asc' } })) flags[r.reason] = r._count._all;
    const stuckBefore = new Date(at.getTime() - thresholds.pending_provider_stuck_minutes * 60_000);
    const stuck = await this.prisma.billingProviderCommand.count({
      where: { state: 'PENDING_PROVIDER', OR: [{ provider_accepted_at: { lte: stuckBefore } }, { provider_accepted_at: null, updated_at: { lte: stuckBefore } }] },
    });
    return { as_of: at, commands_by_state: commands, commands_pending_provider_past_threshold: stuck, webhook_inbox_by_status: inbox, open_reconciliation_flags_by_reason: flags, open_alerts_by_type: await this.openAlertsByType('BILLING'), thresholds };
  }

  async approvalMetrics(at: Date, thresholds: CommercialAlertThresholds = commercialAlertThresholds()): Promise<ApprovalOperationsMetrics> {
    const states = zeroCounts(COMMERCIAL_CHANGE_REQUEST_STATES);
    for (const r of await this.prisma.commercialChangeRequest.groupBy({ by: ['state'], _count: { _all: true } })) states[r.state as keyof typeof states] = r._count._all;
    const leadUntil = new Date(at.getTime() + thresholds.approval_expiry_lead_minutes * 60_000);
    const nearing = await this.prisma.commercialChangeRequest.count({ where: { state: 'PENDING_APPROVAL', expires_at: { gt: at, lte: leadUntil } } });
    const past = await this.prisma.commercialChangeRequest.count({ where: { state: 'PENDING_APPROVAL', expires_at: { lte: at } } });
    return { as_of: at, change_requests_by_state: states, pending_approval_nearing_expiry: nearing, pending_approval_past_expiry: past, open_alerts_by_type: await this.openAlertsByType('APPROVAL'), thresholds };
  }
}
