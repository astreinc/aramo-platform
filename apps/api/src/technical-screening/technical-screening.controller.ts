import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId, hashCanonicalizedBody } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { IdempotencyService } from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  TechnicalScreeningService,
  type ScreeningFindingRow,
  type ScreeningPublicationRow,
  type ScreeningSessionRow,
} from '@aramo/technical-screening';

import { ScreeningAccessService } from './screening-access.service.js';

// TIP-E2E INC-3 — Manual Technical Screening HTTP surface
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8/§9). Every route: JwtAuthGuard +
// EntitlementGuard + RolesGuard, @RequireCapability('ats'), @RequireScopes, the
// in-handler recruiter-only check, and row-level tenant+site access with 404
// concealment (ScreeningAccessService). The acting tenant and actor come ONLY
// from the verified auth context. Manual capture — no AI, nothing inferred; no
// write into Examination, Pipeline or Submittal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScreeningSessionView {
  id: string;
  talent_record_id: string;
  interaction_id: string | null;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string;
  confirmed_by_actor_id: string | null;
  confirmed_at: string | null;
  confirmed_version: number | null;
  voided_by_actor_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

export interface ScreeningFindingView {
  id: string;
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreeningPublicationView {
  id: string;
  finding_id: string;
  evidence_record_id: string;
  state: string;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null;
  published_at: string | null;
  created_at: string;
  // The published evidence's CURRENT Talent Trust status (directive §5); null
  // until published.
  trust_status: string | null;
}

export interface ScreeningSessionDetailView {
  session: ScreeningSessionView;
  findings: ScreeningFindingView[];
  publications: ScreeningPublicationView[];
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function sessionView(s: ScreeningSessionRow): ScreeningSessionView {
  return {
    id: s.id,
    talent_record_id: s.talent_record_id,
    interaction_id: s.interaction_id,
    state: s.state,
    version: s.version,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
    created_by_actor_id: s.created_by_actor_id,
    confirmed_by_actor_id: s.confirmed_by_actor_id,
    confirmed_at: iso(s.confirmed_at),
    confirmed_version: s.confirmed_version,
    voided_by_actor_id: s.voided_by_actor_id,
    voided_at: iso(s.voided_at),
    void_reason: s.void_reason,
  };
}

function findingView(f: ScreeningFindingRow): ScreeningFindingView {
  return {
    id: f.id,
    skill_raw: f.skill_raw,
    basis: f.basis,
    observation_raw: f.observation_raw,
    demonstration_raw: f.demonstration_raw,
    limitations_raw: f.limitations_raw,
    created_at: f.created_at.toISOString(),
    updated_at: f.updated_at.toISOString(),
  };
}

function publicationView(p: ScreeningPublicationRow, trustStatus: string | null): ScreeningPublicationView {
  return {
    id: p.id,
    finding_id: p.finding_id,
    evidence_record_id: p.evidence_record_id,
    state: p.state,
    attempt_count: p.attempt_count,
    last_attempt_at: iso(p.last_attempt_at),
    last_error_code: p.last_error_code,
    published_at: iso(p.published_at),
    created_at: p.created_at.toISOString(),
    trust_status: trustStatus,
  };
}

function requireIdempotencyKey(key: string | undefined, requestId: string): string {
  if (key === undefined || key.length === 0) {
    throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key header is required', 400, {
      requestId,
      details: { missing_field: 'Idempotency-Key' },
    });
  }
  if (!UUID_RE.test(key)) {
    throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be a UUID', 400, {
      requestId,
      details: { invalid_field: 'Idempotency-Key' },
    });
  }
  return key;
}

type Body = Record<string, unknown> | undefined;

@Controller('v1/talent-records/:talentId/screening-sessions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentScreeningSessionsController {
  constructor(
    private readonly screening: TechnicalScreeningService,
    private readonly access: ScreeningAccessService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:create')
  async create(
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionView> {
    this.access.assertRecruiter(auth, requestId);
    const talent = await this.access.talentFor(auth, talentId, requestId);
    this.access.assertLive(talent, requestId);
    const interaction = body?.['interaction_id'];
    if (interaction !== undefined && interaction !== null && (typeof interaction !== 'string' || !UUID_RE.test(interaction))) {
      throw new AramoError('VALIDATION_ERROR', 'interaction_id must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'interaction_id' },
      });
    }
    const session = await this.screening.createSession({
      tenant_id: auth.tenant_id,
      site_id: talent.site_id,
      talent_record_id: talent.id,
      interaction_id: typeof interaction === 'string' ? interaction : null,
      actor_id: auth.sub,
    });
    return sessionView(session);
  }

  @Get()
  @RequireScopes('screening:read')
  async list(
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ items: ScreeningSessionView[] }> {
    this.access.assertRecruiter(auth, requestId);
    const talent = await this.access.talentFor(auth, talentId, requestId);
    const sessions = await this.screening.listForTalent(auth.tenant_id, talent.id);
    return { items: sessions.map(sessionView) };
  }
}

@Controller('v1/screening-sessions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ScreeningSessionController {
  constructor(
    private readonly screening: TechnicalScreeningService,
    private readonly access: ScreeningAccessService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':id')
  @RequireScopes('screening:read')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    return this.detail(auth, id, requestId);
  }

  @Post(':id/findings')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('screening:edit')
  async addFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.addFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      actor_id: auth.sub,
      finding: findingInput(body),
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Patch(':id/findings/:findingId')
  @RequireScopes('screening:edit')
  async editFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.editFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      finding_id: findingId,
      version: body?.['version'],
      actor_id: auth.sub,
      finding: findingInput(body),
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  @Delete(':id/findings/:findingId')
  @RequireScopes('screening:edit')
  async removeFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Query('version') version: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    const parsed = version !== undefined && /^\d+$/.test(version) ? Number(version) : version;
    await this.screening.removeFinding({
      tenant_id: auth.tenant_id,
      session_id: id,
      finding_id: findingId,
      version: parsed,
      actor_id: auth.sub,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // Directive §6 + §7(a) — confirm (atomic with the pinned intents), then ONE
  // synchronous publication attempt. A publication failure never rolls the
  // confirmation back: the intent stays PENDING and the response shows it.
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:confirm')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const key = requireIdempotencyKey(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody({ route: 'screening.confirm', id, body: body ?? {} });
    const lookup = await this.idempotency.lookup({ tenant_id: auth.tenant_id, key, request_hash: requestHash, requestId });
    if (lookup.kind === 'replay') return lookup.response_body as ScreeningSessionDetailView;

    const { talent } = await this.access.sessionFor(auth, id, requestId);
    this.access.assertLive(talent, requestId);
    await this.screening.confirm({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      confirmed_finding_ids: body?.['confirmed_finding_ids'],
      observations_confirmed: body?.['observations_confirmed'],
      actor_id: auth.sub,
      requestId,
    });
    await this.screening.publishPending({ tenant_id: auth.tenant_id, session_id: id, actor_id: auth.sub, requestId });
    const response = await this.detail(auth, id, requestId);
    await this.idempotency.persist({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:edit')
  async voidSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Body,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    await this.access.sessionFor(auth, id, requestId);
    await this.screening.voidSession({
      tenant_id: auth.tenant_id,
      session_id: id,
      version: body?.['version'],
      reason: body?.['reason'],
      actor_id: auth.sub,
      requestId,
    });
    return this.detail(auth, id, requestId);
  }

  // Directive §7(b) — retry PENDING intents; no re-attestation. Idempotent by
  // construction (a PUBLISHED/CONFLICT intent is skipped); the Idempotency-Key
  // replays the first response for a duplicate request.
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('screening:confirm')
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ScreeningSessionDetailView> {
    this.access.assertRecruiter(auth, requestId);
    const key = requireIdempotencyKey(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody({ route: 'screening.publish', id });
    const lookup = await this.idempotency.lookup({ tenant_id: auth.tenant_id, key, request_hash: requestHash, requestId });
    if (lookup.kind === 'replay') return lookup.response_body as ScreeningSessionDetailView;

    await this.access.sessionFor(auth, id, requestId);
    await this.screening.publishPending({ tenant_id: auth.tenant_id, session_id: id, actor_id: auth.sub, requestId });
    const response = await this.detail(auth, id, requestId);
    await this.idempotency.persist({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  private async detail(auth: AuthContextType, id: string, requestId: string): Promise<ScreeningSessionDetailView> {
    const d = await this.screening.getDetail(auth.tenant_id, id, requestId);
    const statuses = await this.access.trustStatuses(auth.tenant_id, d.publications);
    return {
      session: sessionView(d.session),
      findings: d.findings.map(findingView),
      publications: d.publications.map((p) => publicationView(p, statuses.get(p.id) ?? null)),
    };
  }
}

function findingInput(body: Body) {
  return {
    skill_raw: body?.['skill_raw'],
    basis: body?.['basis'],
    observation_raw: body?.['observation_raw'],
    demonstration_raw: body?.['demonstration_raw'],
    limitations_raw: body?.['limitations_raw'],
  };
}
