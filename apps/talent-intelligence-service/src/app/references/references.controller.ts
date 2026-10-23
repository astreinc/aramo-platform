import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import {
  ContradictionResolutionService,
  ProfileReadService,
  ReadRefusedError,
  VerificationStatusService,
  type ServicePrincipal,
  type SourceTuple,
} from '@aramo/intelligence-core';
import {
  INTELLIGENCE_PROPOSALS_SCOPE,
  INTELLIGENCE_READ_SCOPE,
  INTELLIGENCE_VERIFY_SCOPE,
  type ContradictionResolutionResponse,
  type IntelligenceArtifactsReadResponse,
  type IntelligenceEvidenceReadResponse,
  type IntelligenceProfileReadResponse,
  type ReferenceVerificationsResponse,
} from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';
import { lifecycle } from '../lifecycle/lifecycle-errors.js';

// ATI-SEP-1 T6 (ADR-0036 §6) — the tenant read API (scope intelligence:read).
// A tenant addresses a subject ONLY through its own reference tuple; there is
// no by-subject route. 403 NOT_ENTITLED / SOURCE_SYSTEM_MISMATCH, 404
// REFERENCE_NOT_FOUND (unknown, erased or audit-retained — indistinguishable).
// T10 adds, on the same reference tuple:
//   GET  verifications (intelligence:verify) — M-1 verification status of the reference's contacts;
//   POST assertions/:assertion_id/contradiction-resolution (intelligence:proposals) — M-3.

const ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function tupleOf(p: Record<string, string>): SourceTuple {
  const t = { source_system_id: p['source_system_id'] ?? '', source_tenant_id: p['source_tenant_id'] ?? '', external_talent_id: p['external_talent_id'] ?? '' };
  if (!ID.test(t.source_system_id) || !ID.test(t.source_tenant_id) || !ID.test(t.external_talent_id)) {
    throw new HttpException({ error: { code: 'INVALID_REQUEST', message: 'invalid reference tuple' } }, HttpStatus.BAD_REQUEST);
  }
  return t;
}

function mapError(err: unknown): never {
  if (err instanceof ReadRefusedError) {
    const status = err.code === 'REFERENCE_NOT_FOUND' ? HttpStatus.NOT_FOUND : HttpStatus.FORBIDDEN;
    throw new HttpException({ error: { code: err.code, message: err.message } }, status);
  }
  throw err;
}

@Controller('v1/references/:source_system_id/:source_tenant_id/:external_talent_id')
@UseGuards(ServiceTokenGuard)
@RequireScope(INTELLIGENCE_READ_SCOPE)
export class ReferencesController {
  constructor(
    private readonly reads: ProfileReadService,
    private readonly verificationStatus: VerificationStatusService,
    private readonly contradictions: ContradictionResolutionService,
  ) {}

  @Get('profile')
  async profile(@Param() params: Record<string, string>, @Req() req: ServiceRequest): Promise<IntelligenceProfileReadResponse> {
    try {
      return await this.reads.profile(req.servicePrincipal as ServicePrincipal, tupleOf(params));
    } catch (err) {
      mapError(err);
    }
  }

  @Get('evidence')
  async evidence(@Param() params: Record<string, string>, @Req() req: ServiceRequest): Promise<IntelligenceEvidenceReadResponse> {
    try {
      return await this.reads.evidence(req.servicePrincipal as ServicePrincipal, tupleOf(params));
    } catch (err) {
      mapError(err);
    }
  }

  @Get('artifacts')
  async artifacts(@Param() params: Record<string, string>, @Req() req: ServiceRequest): Promise<IntelligenceArtifactsReadResponse> {
    try {
      return await this.reads.artifacts(req.servicePrincipal as ServicePrincipal, tupleOf(params));
    } catch (err) {
      mapError(err);
    }
  }

  @Get('verifications')
  @RequireScope(INTELLIGENCE_VERIFY_SCOPE)
  verifications(@Param() params: Record<string, string>, @Req() req: ServiceRequest): Promise<ReferenceVerificationsResponse> {
    return lifecycle(() => this.verificationStatus.forReference(tupleOf(params), req.servicePrincipal as ServicePrincipal));
  }

  @Post('assertions/:assertion_id/contradiction-resolution')
  @HttpCode(HttpStatus.OK)
  @RequireScope(INTELLIGENCE_PROPOSALS_SCOPE)
  resolveContradiction(
    @Param() params: Record<string, string>,
    @Param('assertion_id', new ParseUUIDPipe()) assertionId: string,
    @Body() body: unknown,
    @Req() req: ServiceRequest,
  ): Promise<ContradictionResolutionResponse> {
    return lifecycle(() => this.contradictions.resolve(tupleOf(params), assertionId, body, req.servicePrincipal as ServicePrincipal));
  }
}
