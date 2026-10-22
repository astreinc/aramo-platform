import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PersonalRiskService, TenantRepository, isPersonalOrDisposableDomain } from '@aramo/identity';
import {
  ABUSE_REPORT_NOTE_MAX,
  AbuseReportService,
  abuseReportConfig,
  emailDomainOf,
  isAbuseReportReason,
  type AbuseReportConfig,
  type AbuseReportReason,
} from '@aramo/sign';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 (correction D) — the
// public "Report this email" intake (POST /v1/sign/report, no sign-in).
//
//   token   the recipient's own signing token (from the link's URL fragment);
//           one report per recipient per envelope
//   scope   only envelopes from a PERSONAL sender (the link appears only there)
//   abuse   per-IP fixed window in memory (the codebase's rate-limit convention on
//           the single box) beside the nginx edge limit; over budget is answered
//           like an accepted report and nothing is recorded
//   effect  weighted total ≥ threshold → identity PersonalRiskService.restrict(
//           tenant, 'abuse_reports', now + 72 h): new sends pause, existing
//           envelopes are unaffected, the account is queued for review, and the
//           pause lapses by itself unless an operator confirms it.
// Guest signing is never touched here.

export const REPORT_IP_BUDGET_MAX = 10;
export const REPORT_IP_BUDGET_WINDOW_MS = 10 * 60 * 1000;
export const ABUSE_RESTRICTION_REASON = 'abuse_reports';

@Injectable()
export class ReportBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  allow(key: string, now: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= REPORT_IP_BUDGET_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= REPORT_IP_BUDGET_MAX) return false;
    w.count += 1;
    return true;
  }
  reset(): void {
    this.windows.clear();
  }
}

export interface ReportBody {
  token?: unknown;
  reason?: unknown;
  note?: unknown;
}

export type ReportOutcome = { received: true };

function invalidLink(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'This report link can’t be used', 404, { requestId, details: { reason: 'report_link_invalid' } });
}

@Injectable()
export class SignReportService {
  private readonly log = new Logger(SignReportService.name);

  constructor(
    private readonly reports: AbuseReportService,
    private readonly tenants: TenantRepository,
    private readonly risk: PersonalRiskService,
    private readonly budget: ReportBudget,
  ) {}

  async submit(body: ReportBody, ip: string | null, requestId: string, now: Date = new Date(), cfg: AbuseReportConfig = abuseReportConfig()): Promise<ReportOutcome> {
    const reason = body?.reason ?? null;
    if (reason !== null && !isAbuseReportReason(reason)) {
      throw new AramoError('VALIDATION_ERROR', 'Choose one of the listed reasons', 400, { requestId, details: { field: 'reason' } });
    }
    const note = body?.note === undefined || body.note === null ? null : body.note;
    if (note !== null && (typeof note !== 'string' || note.length > ABUSE_REPORT_NOTE_MAX)) {
      throw new AramoError('VALIDATION_ERROR', `note must be text of at most ${ABUSE_REPORT_NOTE_MAX} characters`, 400, { requestId, details: { field: 'note' } });
    }
    if (typeof body?.token !== 'string') throw invalidLink(requestId);
    // Over budget: answered like an accepted report, nothing recorded.
    if (!this.budget.allow(`ip:${ip ?? 'unknown'}`, now.getTime())) {
      this.log.warn(`report budget exceeded (request ${requestId})`);
      return { received: true };
    }
    const ctx = await this.reports.resolveReportContext(body.token, now, cfg);
    if (ctx === null) throw invalidLink(requestId);
    const tenant = await this.tenants.findById(ctx.tenant_id);
    // Reports are taken only for Personal senders (the only emails carrying the link).
    if (tenant === null || tenant.kind !== 'PERSONAL') throw invalidLink(requestId);
    const domain = emailDomainOf(ctx.signer_email);
    const recorded = await this.reports.record({
      context: ctx,
      reason: reason as AbuseReportReason | null,
      note: typeof note === 'string' && note.trim() !== '' ? note.trim() : null,
      // A shared consumer mail domain says nothing about independence: group by person.
      group_by: domain === '' || isPersonalOrDisposableDomain(domain) ? 'reporter' : 'domain',
      at: now,
      cfg,
    });
    if (recorded.kind === 'duplicate') {
      throw new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'This email has already been reported', 409, { requestId, details: { reason: 'already_reported' } });
    }
    this.log.log(`abuse report ${recorded.report_id} tenant=${ctx.tenant_id} weight=${recorded.weight.weight} total=${recorded.tenant_total}`);
    if (recorded.tenant_total >= cfg.threshold) {
      const until = new Date(now.getTime() + cfg.restrictionHours * 3_600_000);
      const view = await this.risk.restrict(ctx.tenant_id, ABUSE_RESTRICTION_REASON, until, null, now);
      await this.reports.markTriggeredRestriction(recorded.report_id);
      this.log.warn(`personal tenant ${ctx.tenant_id} paused by weighted abuse reports until ${view.restricted_until?.toISOString() ?? 'operator decision'}`);
    }
    return { received: true };
  }
}
