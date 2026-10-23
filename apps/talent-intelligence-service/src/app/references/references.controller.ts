import { Controller, Get, HttpException, HttpStatus, Param, Req, UseGuards } from '@nestjs/common';
import { ProfileReadService, ReadRefusedError, type ServicePrincipal, type SourceTuple } from '@aramo/intelligence-core';
import {
  INTELLIGENCE_READ_SCOPE,
  type IntelligenceArtifactsReadResponse,
  type IntelligenceEvidenceReadResponse,
  type IntelligenceProfileReadResponse,
} from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

// ATI-SEP-1 T6 (ADR-0036 §6) — the tenant read API (scope intelligence:read).
// A tenant addresses a subject ONLY through its own reference tuple; there is
// no by-subject route. 403 NOT_ENTITLED / SOURCE_SYSTEM_MISMATCH, 404
// REFERENCE_NOT_FOUND (unknown, erased or audit-retained — indistinguishable).

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
  constructor(private readonly reads: ProfileReadService) {}

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
}
