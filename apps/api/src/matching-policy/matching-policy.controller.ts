import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { parseEvidenceThresholds } from '@aramo/matching';
import {
  MatchingPolicyRepository,
  MatchingPolicyVersionNotFoundError,
  type MatchingPolicyVersionRow,
  type SkillActor,
} from '@aramo/skills-taxonomy';

import { CreateMatchingPolicyVersionDto } from './matching-policy.dto.js';

// ATI-SEP-1 Addendum A2 ruling A-c (P1) — the platform MatchingPolicy HTTP surface.
// "Skills taxonomy and matching configuration are platform-owned and governed by the
// SaaS Platform Owner through the Platform Admin Portal; tenants consume, cannot edit;
// ATS matching execution stays ATS-side."
//
// AuthZ posture mirrors SkillGovernanceController: class-level
// @UseGuards(JwtAuthGuard, RolesGuard); per-route @RequireScopes; per-route
// consumer_type === 'platform' assertion (the DDR §13.1 tripwire app-side — a tenant
// token never satisfies a platform route). Read → platform:matching_policy:read;
// create a version / activate a version → platform:matching_policy:write. There is NO
// tenant-tier route of any kind (read or write).
//
// Every change is audited (MatchingPolicyAuditEvent, same transaction as the write).
// The engine itself never runs here: libs/matching reads the ACTIVE version through
// the MATCHING_POLICY_SOURCE port (MatchingPolicyModule).
@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MatchingPolicyController {
  constructor(private readonly store: MatchingPolicyRepository) {}

  // The ACTIVE version + the full version history (newest first). `active` is null
  // only when the store is empty (the engine then applies the compiled defaults).
  @Get('matching-policy')
  @RequireScopes('platform:matching_policy:read')
  async getPolicy(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ active: MatchingPolicyVersionView | null; versions: MatchingPolicyVersionView[] }> {
    this.assertPlatform(auth, requestId);
    const versions = await this.store.listVersions();
    const active = versions.find((v) => v.status === 'ACTIVE') ?? null;
    return {
      active: active === null ? null : toView(active),
      versions: versions.map(toView),
    };
  }

  // Appends a DRAFT version. Never changes what matching runs with until activated.
  @Post('matching-policy/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:matching_policy:write')
  async createVersion(
    @Body() body: CreateMatchingPolicyVersionDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MatchingPolicyVersionView> {
    this.assertPlatform(auth, requestId);
    const parsed = parseEvidenceThresholds(body.evidence_thresholds);
    if (!parsed.ok) {
      throw new AramoError('VALIDATION_ERROR', 'Invalid evidence_thresholds', 400, {
        requestId,
        details: { errors: [...parsed.errors] },
      });
    }
    const row = await this.store.createVersion({
      evidence_thresholds: { ...parsed.thresholds },
      note: body.note ?? null,
      actor: this.actor(auth),
    });
    return toView(row);
  }

  // Makes the version the ONE ACTIVE version (the previous ACTIVE version is
  // RETIRED). Re-activating a RETIRED version is the rollback path; activating the
  // ACTIVE version is a no-op that returns it.
  @Post('matching-policy/versions/:id/activate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:matching_policy:write')
  async activateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MatchingPolicyVersionView> {
    this.assertPlatform(auth, requestId);
    try {
      const target = await this.store.getById(id);
      if (target === null) throw new MatchingPolicyVersionNotFoundError(id);
      // Never activate a document the engine could not read.
      const parsed = parseEvidenceThresholds(target.evidence_thresholds);
      if (!parsed.ok) {
        throw new AramoError('VALIDATION_ERROR', 'Stored evidence_thresholds are malformed', 400, {
          requestId,
          details: { errors: [...parsed.errors] },
        });
      }
      const { row } = await this.store.activateVersion(id, this.actor(auth));
      return toView(row);
    } catch (e) {
      if (e instanceof MatchingPolicyVersionNotFoundError) {
        throw new AramoError('NOT_FOUND', 'Matching policy version not found', 404, { requestId });
      }
      throw e;
    }
  }

  // ---- Internal ----------------------------------------------------------

  private actor(auth: AuthContextType): SkillActor {
    return { id: auth.sub, type: auth.actor_kind };
  }

  private assertPlatform(auth: AuthContextType, requestId: string): void {
    // DDR §13.1 tripwire app-side — a tenant token cannot satisfy a platform route.
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
  }
}

// ---- Response view (platform-global reference data; no tenant data, no PII) ---

interface MatchingPolicyVersionView {
  id: string;
  version_number: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  evidence_thresholds: unknown;
  note: string | null;
  created_by: string | null;
  created_at: string;
  activated_by: string | null;
  activated_at: string | null;
  retired_at: string | null;
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function toView(r: MatchingPolicyVersionRow): MatchingPolicyVersionView {
  return {
    id: r.id,
    version_number: r.version_number,
    status: r.status,
    evidence_thresholds: r.evidence_thresholds,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    activated_by: r.activated_by,
    activated_at: iso(r.activated_at),
    retired_at: iso(r.retired_at),
  };
}
