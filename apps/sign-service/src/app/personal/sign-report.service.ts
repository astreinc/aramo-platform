import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PersonalRiskService, TenantRepository, isPersonalOrDisposableDomain } from '@aramo/identity';
import {
  ABUSE_REPORT_NOTE_MAX,
  type AbuseReportContext,
  AbuseReportService,
  abuseReportConfig,
  emailDomainOf,
  isAbuseReportReason,
  type AbuseReportConfig,
  type AbuseReportReason,
} from '@aramo/sign';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 (correction D) and
// Amendment M-A7 §5.2 (R-11) — the "Report this email" intake.
//
//   token   POST /v1/sign/report (public, no sign-in): the recipient's own signing
//           token (from the link's URL fragment)
//   inbox   POST /v1/sign/inbox/:id/report (signed in, M-A7 §5.2): the user's own
//           claimed inbox item, so the app never handles a token for this
//           one report per recipient per envelope, either way
//   scope   every sender (M-A7 §5.2: the link is in every signing request and
//           reminder email, Business and Personal alike)
//   abuse   per-IP (token) or per-user (inbox) fixed window in memory (the
//           codebase's rate-limit convention on the single box) beside the nginx
//           edge limit; over budget is answered like an accepted report and
//           nothing is recorded
//   effect  PERSONAL sender: weighted total ≥ threshold → identity
//           PersonalRiskService.restrict(tenant, 'abuse_reports', now + 72 h): new
//           sends pause, existing envelopes are unaffected, the account is queued
//           for review, and the pause lapses by itself unless an operator
//           confirms it.
//           BUSINESS sender: recorded and routed to Aramo operators (the queue
//           GET /platform/sign-abuse-reports); never an automatic pause.
// Guest signing is never touched here.

export const REPORT_IP_BUDGET_MAX = 10;
export const REPORT_IP_BUDGET_WINDOW_MS = 10 * 60 * 1000;
export const ABUSE_RESTRICTION_REASON = 'abuse_reports';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function validated(body: Omit<ReportBody, 'token'> | undefined, requestId: string): { reason: AbuseReportReason | null; note: string | null } {
  const reason = body?.reason ?? null;
  if (reason !== null && !isAbuseReportReason(reason)) {
    throw new AramoError('VALIDATION_ERROR', 'Choose one of the listed reasons', 400, { requestId, details: { field: 'reason' } });
  }
  const note = body?.note === undefined || body.note === null ? null : body.note;
  if (note !== null && (typeof note !== 'string' || note.length > ABUSE_REPORT_NOTE_MAX)) {
    throw new AramoError('VALIDATION_ERROR', `note must be text of at most ${ABUSE_REPORT_NOTE_MAX} characters`, 400, { requestId, details: { field: 'note' } });
  }
  return { reason, note: typeof note === 'string' && note.trim() !== '' ? note.trim() : null };
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
    const { reason, note } = validated(body, requestId);
    if (typeof body?.token !== 'string') throw invalidLink(requestId);
    // Over budget: answered like an accepted report, nothing recorded.
    if (!this.budget.allow(`ip:${ip ?? 'unknown'}`, now.getTime())) {
      this.log.warn(`report budget exceeded (request ${requestId})`);
      return { received: true };
    }
    const ctx = await this.reports.resolveReportContext(body.token, now, cfg);
    if (ctx === null) throw invalidLink(requestId);
    return this.file(ctx, reason, note, requestId, () => invalidLink(requestId), now, cfg);
  }

  /** M-A7 §5.2 — a report from the app's received-envelope view (the user's own inbox item). */
  async submitFromInbox(user_id: string, binding_id: string, body: Omit<ReportBody, 'token'>, requestId: string, now: Date = new Date(), cfg: AbuseReportConfig = abuseReportConfig()): Promise<ReportOutcome> {
    const { reason, note } = validated(body, requestId);
    const notInInbox = () => new AramoError('NOT_FOUND', 'Not in your inbox', 404, { requestId });
    if (!this.budget.allow(`user:${user_id}`, now.getTime())) {
      this.log.warn(`report budget exceeded (request ${requestId})`);
      return { received: true };
    }
    if (!UUID.test(binding_id)) throw notInInbox();
    const ctx = await this.reports.resolveInboxReportContext(user_id, binding_id);
    if (ctx === null) throw notInInbox();
    return this.file(ctx, reason, note, requestId, notInInbox, now, cfg);
  }

  private async file(
    ctx: AbuseReportContext,
    reason: AbuseReportReason | null,
    note: string | null,
    requestId: string,
    unusable: () => AramoError,
    now: Date,
    cfg: AbuseReportConfig,
  ): Promise<ReportOutcome> {
    const tenant = await this.tenants.findById(ctx.tenant_id);
    if (tenant === null) throw unusable();
    const personal = tenant.kind === 'PERSONAL';
    const domain = emailDomainOf(ctx.signer_email);
    const recorded = await this.reports.record({
      context: ctx,
      reason,
      note,
      // A shared consumer mail domain says nothing about independence: group by person.
      group_by: domain === '' || isPersonalOrDisposableDomain(domain) ? 'reporter' : 'domain',
      at: now,
      cfg,
    });
    if (recorded.kind === 'duplicate') {
      throw new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'This email has already been reported', 409, { requestId, details: { reason: 'already_reported' } });
    }
    if (!personal) {
      // M-A7 §5.2 — a Business sender is never paused automatically: the report
      // waits in the operators' queue (outcome OPEN) for a person to review.
      this.log.warn(`abuse report ${recorded.report_id} on business tenant=${ctx.tenant_id} queued for operator review (request ${requestId})`);
      return { received: true };
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
