import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AbuseReportService, type AbuseReportView } from '@aramo/sign';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  PersonalRiskService,
  PersonalSignupRepository,
  classifyEmailDomain,
  extractEmailDomain,
  normalizeEmail,
  personalPilotCap,
  type PersonalReviewItem,
  type TenantRiskStateView,
} from '@aramo/identity';

import { DecideAbuseReportRequestDto, IssuePersonalInviteRequestDto, PersonalRiskActionRequestDto } from './dto/personal.request.dto.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.5 / §10 — the
// operator's Personal surface: the review queue (accounts held for review and
// accounts restricted, with every stored signal), the four audited actions
// (clear review = approve, restrict, reinstate, close — a person decides, each
// with a reason) and pilot invite issue (the code is shown ONCE; only its hash is
// stored). Lifecycle power (platform:tenant:lifecycle:manage), platform consumer
// only (the DDR §13.1 tripwire). Clearing review NEVER sets phone assurance.

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformPersonalController {
  constructor(
    private readonly risk: PersonalRiskService,
    private readonly signups: PersonalSignupRepository,
    // §6.4 — abuse reports live in the sign schema; the operator reads them and
    // records outcomes (FALSE_REPORT lowers that reporter's future weight).
    private readonly reports: AbuseReportService,
  ) {}

  @Get('personal-review')
  @RequireScopes('platform:tenant:lifecycle:manage')
  async reviewQueue(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ items: PersonalReviewItem[] }> {
    assertPlatform(auth, requestId);
    return { items: await this.signups.reviewQueue() };
  }

  @Post('personal-invites')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async issueInvite(@Body() body: IssuePersonalInviteRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ code: string; email: string; expires_at: string }> {
    assertPlatform(auth, requestId);
    const email = normalizeEmail(body.email);
    if (classifyEmailDomain(extractEmailDomain(email)) !== 'personal') {
      throw new AramoError('VALIDATION_ERROR', 'A personal invite needs a personal email address', 400, { requestId, details: { reason: 'personal_email_required' } });
    }
    if ((await this.signups.activePersonalTenantCount()) >= personalPilotCap()) {
      throw new AramoError('VALIDATION_ERROR', 'The personal pilot is full', 400, { requestId, details: { reason: 'personal_pilot_full', cap: personalPilotCap() } });
    }
    const invite = await this.signups.issueInvite(email, auth.sub, new Date());
    return { code: invite.code, email: invite.email, expires_at: invite.expires_at.toISOString() };
  }

  @Post('tenants/:tenant_id/personal/clear-review')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async clearReview(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @Body() body: PersonalRiskActionRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    await this.mustExist(tenant_id, requestId);
    return view(await this.risk.clearReview(tenant_id, auth.sub, body.reason));
  }

  @Post('tenants/:tenant_id/personal/restrict')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async restrict(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @Body() body: PersonalRiskActionRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const cur = await this.mustExist(tenant_id, requestId);
    if (cur.state === 'closed') {
      throw new AramoError('VALIDATION_ERROR', 'This personal account is closed', 400, { requestId, details: { reason: 'illegal_risk_transition', from: 'closed', action: 'restrict' } });
    }
    const until = body.until === undefined ? null : new Date(body.until);
    if (until !== null && until.getTime() <= Date.now()) {
      throw new AramoError('VALIDATION_ERROR', 'The restriction end must be in the future', 400, { requestId, details: { reason: 'until_in_past' } });
    }
    return view(await this.risk.restrict(tenant_id, body.reason, until, auth.sub));
  }

  @Post('tenants/:tenant_id/personal/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async reinstate(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @Body() body: PersonalRiskActionRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    await this.mustExist(tenant_id, requestId);
    return view(await this.risk.reinstate(tenant_id, auth.sub, body.reason));
  }

  @Post('tenants/:tenant_id/personal/close')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async close(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @Body() body: PersonalRiskActionRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    await this.mustExist(tenant_id, requestId);
    return view(await this.risk.close(tenant_id, auth.sub, body.reason));
  }

  @Get('tenants/:tenant_id/personal/reports')
  @RequireScopes('platform:tenant:lifecycle:manage')
  async reportsFor(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ items: ReturnType<typeof reportView>[] }> {
    assertPlatform(auth, requestId);
    await this.mustExist(tenant_id, requestId);
    return { items: (await this.reports.listForTenant(tenant_id)).map(reportView) };
  }

  @Post('personal-reports/:report_id/decide')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async decideReport(@Param('report_id', new ParseUUIDPipe()) report_id: string, @Body() body: DecideAbuseReportRequestDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    assertPlatform(auth, requestId);
    const decided = await this.reports.decide({ report_id, outcome: body.outcome, actor: auth.sub, reason: body.reason });
    if (decided === null) throw new AramoError('NOT_FOUND', 'Report not found', 404, { requestId, details: { report_id } });
    return reportView(decided);
  }

  private async mustExist(tenant_id: string, requestId: string): Promise<TenantRiskStateView> {
    const cur = await this.risk.riskStateOf(tenant_id);
    if (cur === null) {
      throw new AramoError('NOT_FOUND', 'This tenant is not a personal account', 404, { requestId, details: { tenant_id, reason: 'no_personal_risk_state' } });
    }
    return cur;
  }
}

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

/** The operator view of a risk state (phone_e164 is never returned). */
function view(v: TenantRiskStateView) {
  return {
    tenant_id: v.tenant_id,
    state: v.state,
    step_up_required: v.step_up_required,
    phone_verified_at: v.phone_verified_at?.toISOString() ?? null,
    restricted_until: v.restricted_until?.toISOString() ?? null,
    reason: v.reason,
    decided_by: v.decided_by,
    updated_at: v.updated_at.toISOString(),
  };
}

/** The operator view of an abuse report (the reporter's address is never stored or returned). */
function reportView(r: AbuseReportView) {
  return {
    id: r.id,
    envelope_id: r.envelope_id,
    reason: r.reason,
    note: r.note,
    reporter_domain: r.reporter_domain,
    weight: r.weight,
    triggered_restriction: r.triggered_restriction,
    outcome: r.outcome,
    outcome_reason: r.outcome_reason,
    decided_at: r.decided_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}
