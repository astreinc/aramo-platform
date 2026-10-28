import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { hashSigningToken } from './signing-token.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 (correction D) — abuse
// reports on signing emails. Since Amendment M-A7 §5.2 (R-11) every sender's
// request and reminder emails carry the link, so reports are recorded for Business
// senders too: they go to the operators' queue (listQueue) and never pause a
// Business tenant; only the Personal automatic pause reads the weighted total.
//
//   Reporting   one report per recipient per envelope, and only from the
//               recipient's own signing link (the signing capability token).
//   Weighting   weight = severity × independence × credibility, each factor kept
//               on the row so every automatic decision is explainable:
//                 severity     phishing / impersonation count more than "don't
//                              know the sender"
//                 independence the k-th earlier report (in the window) from the
//                              same reporter group, or on the same envelope,
//                              counts for less (distinct recipients, envelopes
//                              and email domains count fully)
//                 credibility  halved for each earlier report by this reporter
//                              that an operator judged FALSE_REPORT
//   Response    the caller (sign-service) compares the tenant's weighted total
//               with the threshold and applies the bounded, reversible
//               temporary restriction (identity owns the account state).
// Recipients' addresses are never stored here: reporter_key is a one-way digest.

export const ABUSE_REPORT_REASONS = ['phishing', 'impersonation', 'spam', 'unknown_sender', 'other'] as const;
export type AbuseReportReason = (typeof ABUSE_REPORT_REASONS)[number];
export const ABUSE_REPORT_OUTCOMES = ['OPEN', 'CONFIRMED', 'FALSE_REPORT', 'DISMISSED'] as const;
export type AbuseReportOutcome = (typeof ABUSE_REPORT_OUTCOMES)[number];
export const ABUSE_REPORT_NOTE_MAX = 1000;

export function isAbuseReportReason(v: unknown): v is AbuseReportReason {
  return typeof v === 'string' && (ABUSE_REPORT_REASONS as readonly string[]).includes(v);
}

export interface AbuseReportConfig {
  // Weighted total (within the window) at which the account is paused.
  threshold: number;
  windowDays: number;
  // How long an automatic pause lasts unless an operator confirms it.
  restrictionHours: number;
  // A report link older than this no longer files reports.
  linkMaxAgeDays: number;
  severity: Readonly<Record<AbuseReportReason | 'none', number>>;
  // Per earlier report from the same reporter group / on the same envelope.
  sameGroupPenalty: number;
  sameEnvelopePenalty: number;
  // Multiplier per earlier FALSE_REPORT by the same reporter, and the floor.
  falseReportFactor: number;
  credibilityFloor: number;
}

export const DEFAULT_ABUSE_REPORT_CONFIG: AbuseReportConfig = {
  threshold: 4,
  windowDays: 30,
  restrictionHours: 72,
  linkMaxAgeDays: 90,
  severity: { phishing: 3, impersonation: 3, spam: 1.5, other: 1, none: 1, unknown_sender: 0.75 },
  sameGroupPenalty: 1,
  sameEnvelopePenalty: 0.5,
  falseReportFactor: 0.5,
  credibilityFloor: 0.1,
};

function positive(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
}

/** Tunable by configuration (§6.2 "tuned through configuration"). */
export function abuseReportConfig(env: NodeJS.ProcessEnv = process.env): AbuseReportConfig {
  return {
    ...DEFAULT_ABUSE_REPORT_CONFIG,
    threshold: positive(env['SIGN_ABUSE_REPORT_THRESHOLD'], DEFAULT_ABUSE_REPORT_CONFIG.threshold, 1000),
    windowDays: positive(env['SIGN_ABUSE_REPORT_WINDOW_DAYS'], DEFAULT_ABUSE_REPORT_CONFIG.windowDays, 365),
    restrictionHours: positive(env['SIGN_ABUSE_RESTRICTION_HOURS'], DEFAULT_ABUSE_REPORT_CONFIG.restrictionHours, 24 * 30),
  };
}

/** The one-way reporter identity: sha256 of the trimmed, lowercased address. */
export function abuseReporterKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export interface AbuseReportContext {
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  signer_email: string;
}

export interface AbuseReportWeight {
  severity: number;
  independence: number;
  credibility: number;
  weight: number;
}

export type RecordAbuseReportResult =
  | { readonly kind: 'recorded'; readonly report_id: string; readonly weight: AbuseReportWeight; readonly tenant_total: number }
  | { readonly kind: 'duplicate' };

export interface AbuseReportView {
  id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  reason: string | null;
  note: string | null;
  reporter_domain: string;
  severity: number;
  independence: number;
  credibility: number;
  weight: number;
  triggered_restriction: boolean;
  outcome: string;
  outcome_reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

const COUNTED_OUTCOMES = ['OPEN', 'CONFIRMED'];

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

@Injectable()
export class AbuseReportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The recipient behind a report link: the signing token resolves the signing
   * session (whatever its state — a reminder supersedes the earlier link, and a
   * recipient may report after signing), within the link's maximum age.
   */
  async resolveReportContext(raw_token: string, at: Date = new Date(), cfg: AbuseReportConfig = DEFAULT_ABUSE_REPORT_CONFIG): Promise<AbuseReportContext | null> {
    if (typeof raw_token !== 'string' || raw_token.length < 16 || raw_token.length > 256) return null;
    const session = await this.prisma.signingSession.findUnique({
      where: { token_hash: hashSigningToken(raw_token) },
      include: { signer: { select: { id: true, email: true, envelope_id: true } } },
    });
    if (session === null) return null;
    if (session.created_at.getTime() < at.getTime() - cfg.linkMaxAgeDays * 86_400_000) return null;
    // M-A5 §3.5 — an in-person signer without an email was never emailed a link.
    if (session.signer.email === null) return null;
    return { tenant_id: session.tenant_id, envelope_id: session.envelope_id, signer_id: session.signer_id, signer_email: session.signer.email };
  }

  /**
   * M-A7 §5.2 — the recipient behind a claimed inbox item (the signed-in user's
   * own, unrevoked binding), so the app's received-envelope view reaches the same
   * report flow without handling a signing token. Null when it is not theirs.
   */
  async resolveInboxReportContext(user_id: string, binding_id: string): Promise<AbuseReportContext | null> {
    const b = await this.prisma.signRecipientBinding.findFirst({
      where: { id: binding_id, user_id, revoked_at: null },
      select: { envelope_tenant_id: true, envelope_id: true, signer_id: true, email: true, signer: { select: { email: true } } },
    });
    if (b === null) return null;
    const signer_email = b.signer.email ?? b.email;
    if (signer_email === '') return null;
    return { tenant_id: b.envelope_tenant_id, envelope_id: b.envelope_id, signer_id: b.signer_id, signer_email };
  }

  /** The weighted total of the tenant's counted reports (OPEN / CONFIRMED) in the window. */
  async tenantTotal(tenant_id: string, at: Date = new Date(), cfg: AbuseReportConfig = DEFAULT_ABUSE_REPORT_CONFIG): Promise<number> {
    const since = new Date(at.getTime() - cfg.windowDays * 86_400_000);
    const agg = await this.prisma.abuseReport.aggregate({
      where: { tenant_id, outcome: { in: COUNTED_OUTCOMES }, created_at: { gt: since } },
      _sum: { weight: true },
    });
    return round3(agg._sum.weight ?? 0);
  }

  /**
   * Records one report (one per recipient per envelope). `group_by` is the
   * independence key the caller chose for this address: `domain` for an
   * organization domain, `reporter` for a shared consumer mail domain (where
   * different people share the domain and must not collapse into one group).
   */
  async record(input: {
    context: AbuseReportContext;
    reason: AbuseReportReason | null;
    note: string | null;
    group_by: 'domain' | 'reporter';
    at?: Date;
    cfg?: AbuseReportConfig;
  }): Promise<RecordAbuseReportResult> {
    const at = input.at ?? new Date();
    const cfg = input.cfg ?? DEFAULT_ABUSE_REPORT_CONFIG;
    const ctx = input.context;
    const reporter_key = abuseReporterKey(ctx.signer_email);
    const reporter_domain = emailDomainOf(ctx.signer_email);
    const since = new Date(at.getTime() - cfg.windowDays * 86_400_000);
    return this.prisma.$transaction(async (tx) => {
      // Serialize the tenant's reports so the weighted total is consistent.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sign-abuse:${ctx.tenant_id}`}, 0))`;
      const existing = await tx.abuseReport.findUnique({ where: { envelope_id_signer_id: { envelope_id: ctx.envelope_id, signer_id: ctx.signer_id } } });
      if (existing !== null) return { kind: 'duplicate' } as const;
      const earlier = await tx.abuseReport.findMany({
        where: { tenant_id: ctx.tenant_id, outcome: { in: COUNTED_OUTCOMES }, created_at: { gt: since } },
        select: { envelope_id: true, reporter_key: true, reporter_domain: true },
      });
      const sameGroup = earlier.filter((r) => (input.group_by === 'domain' ? r.reporter_domain === reporter_domain : r.reporter_key === reporter_key)).length;
      const sameEnvelope = earlier.filter((r) => r.envelope_id === ctx.envelope_id).length;
      const falseBefore = await tx.abuseReport.count({ where: { reporter_key, outcome: 'FALSE_REPORT' } });
      const weight = weighReport({ reason: input.reason, sameGroup, sameEnvelope, falseBefore }, cfg);
      const id = randomUUID();
      await tx.abuseReport.create({
        data: {
          id,
          tenant_id: ctx.tenant_id,
          envelope_id: ctx.envelope_id,
          signer_id: ctx.signer_id,
          reason: input.reason,
          note: input.note,
          reporter_key,
          reporter_domain,
          ...weight,
          created_at: at,
        },
      });
      const agg = await tx.abuseReport.aggregate({
        where: { tenant_id: ctx.tenant_id, outcome: { in: COUNTED_OUTCOMES }, created_at: { gt: since } },
        _sum: { weight: true },
      });
      return { kind: 'recorded', report_id: id, weight, tenant_total: round3(agg._sum.weight ?? 0) } as const;
    });
  }

  async markTriggeredRestriction(report_id: string): Promise<void> {
    await this.prisma.abuseReport.update({ where: { id: report_id }, data: { triggered_restriction: true } });
  }

  /**
   * The operator's judgement of a report. FALSE_REPORT excludes it from the
   * tenant's total and lowers the reporter's future credibility; DISMISSED
   * excludes it without judging the reporter; CONFIRMED keeps it counted.
   */
  async decide(input: { report_id: string; outcome: Exclude<AbuseReportOutcome, 'OPEN'>; actor: string; reason: string; at?: Date }): Promise<AbuseReportView | null> {
    const found = await this.prisma.abuseReport.findUnique({ where: { id: input.report_id } });
    if (found === null) return null;
    const row = await this.prisma.abuseReport.update({
      where: { id: input.report_id },
      data: { outcome: input.outcome, outcome_reason: input.reason.slice(0, 500), decided_by: input.actor, decided_at: input.at ?? new Date() },
    });
    return toView(row);
  }

  async listForTenant(tenant_id: string, limit = 100): Promise<AbuseReportView[]> {
    const rows = await this.prisma.abuseReport.findMany({ where: { tenant_id }, orderBy: { created_at: 'desc' }, take: Math.min(Math.max(limit, 1), 500) });
    return rows.map(toView);
  }

  /**
   * M-A7 §5.2 — the operators' queue across every sender (Business and Personal),
   * newest first; `outcome` narrows it (OPEN = still to be reviewed).
   */
  async listQueue(opts: { outcome?: AbuseReportOutcome; limit?: number } = {}): Promise<AbuseReportView[]> {
    const rows = await this.prisma.abuseReport.findMany({
      where: opts.outcome === undefined ? {} : { outcome: opts.outcome },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    });
    return rows.map(toView);
  }
}

/** Pure weighting (unit-testable): severity × independence × credibility. */
export function weighReport(
  input: { reason: AbuseReportReason | null; sameGroup: number; sameEnvelope: number; falseBefore: number },
  cfg: AbuseReportConfig = DEFAULT_ABUSE_REPORT_CONFIG,
): AbuseReportWeight {
  const severity = cfg.severity[input.reason ?? 'none'];
  const independence = 1 / (1 + cfg.sameGroupPenalty * input.sameGroup + cfg.sameEnvelopePenalty * input.sameEnvelope);
  const credibility = Math.max(cfg.credibilityFloor, Math.pow(cfg.falseReportFactor, input.falseBefore));
  return {
    severity: round3(severity),
    independence: round3(independence),
    credibility: round3(credibility),
    weight: round3(severity * independence * credibility),
  };
}

function toView(r: {
  id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  reason: string | null;
  note: string | null;
  reporter_domain: string;
  severity: number;
  independence: number;
  credibility: number;
  weight: number;
  triggered_restriction: boolean;
  outcome: string;
  outcome_reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}): AbuseReportView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    envelope_id: r.envelope_id,
    signer_id: r.signer_id,
    reason: r.reason,
    note: r.note,
    reporter_domain: r.reporter_domain,
    severity: r.severity,
    independence: r.independence,
    credibility: r.credibility,
    weight: r.weight,
    triggered_restriction: r.triggered_restriction,
    outcome: r.outcome,
    outcome_reason: r.outcome_reason,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
  };
}
