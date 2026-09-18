import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  SkillRegistryService,
  SkillGovernanceService,
  SkillValidationError,
  SkillNotFoundError,
  SkillConflictError,
  SkillAliasConflictError,
  SkillVersionConflictError,
  SkillRelationshipConflictError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  ProposalPayloadError,
  ProposalApplyConflictError,
  type SkillActor,
} from '@aramo/skills-taxonomy';

import { SkillReviewQueueService, ReviewQueueCursorError } from './skill-review-queue.service.js';
import {
  AddAliasDto,
  AddRelationshipDto,
  AddVersionDto,
  CreateProposalDto,
  CreateSkillDto,
  ListProposalsQueryDto,
  ListSkillsQueryDto,
  MergeSkillDto,
  OverrideSkillDto,
  RejectProposalDto,
  ReviewQueueQueryDto,
  SkillChildListQueryDto,
  UpdateSkillDto,
  UpdateVersionDto,
} from './dto/skill-governance.dto.js';

// SKILL-TAX-1F-B2 — the platform skill-governance HTTP surface. Serves the
// canonical skills-taxonomy administration + the AI-proposal ratification console
// under the /platform namespace. This lives in apps/api (untagged) because the
// review queue bridges scope:cip (talent-evidence) + scope:ats (requisition), which
// the scope:platform app cannot import.
//
// AuthZ posture mirrors PlatformController (AUTHZ-2): class-level
// @UseGuards(JwtAuthGuard, RolesGuard); per-route @RequireScopes('platform:skill:*');
// per-route consumer_type === 'platform' assertion (the DDR §13.1 tripwire app-side
// — a tenant token never satisfies a platform route). Reads → platform:skill:read;
// mutations/decisions → platform:skill:manage.
//
// This controller is a THIN boundary: it validates shape, asserts the tier + scope,
// delegates to the skills-taxonomy services (canonical writes reuse ONE registry
// primitive) and the apps/api review-queue service, and translates domain errors to
// the governed AramoError codes. It contains ZERO canonical-repoint / reconciliation
// fan-out logic — that belongs exclusively to the B1 durable propagation engine.
@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SkillGovernanceController {
  constructor(
    private readonly registry: SkillRegistryService,
    private readonly governance: SkillGovernanceService,
    private readonly reviewQueue: SkillReviewQueueService,
  ) {}

  // ---- Canonical Skill registry ------------------------------------------

  @Get('skills')
  @RequireScopes('platform:skill:read')
  async listSkills(
    @Query() query: ListSkillsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ skills: SkillView[] }> {
    this.assertPlatform(auth, requestId);
    const skills = await this.registry.listSkills({ includeInactive: query.include_inactive === 'true' });
    return { skills: skills.map(toSkillView) };
  }

  // SKILL-TAX-1F-B3 — governance detail reads. A console skill-detail page fetches the
  // skill plus its aliases / versions / relationships as separate reads. All reuse the
  // existing registry read primitives (no new domain logic, no mutation).

  @Get('skills/:id')
  @RequireScopes('platform:skill:read')
  async getSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    const skill = await this.registry.getSkillById(id);
    if (skill === null) {
      throw new AramoError('NOT_FOUND', 'Skill not found', 404, { requestId });
    }
    return toSkillView(skill);
  }

  @Get('skills/:id/aliases')
  @RequireScopes('platform:skill:read')
  async listSkillAliases(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SkillChildListQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ aliases: AliasView[] }> {
    this.assertPlatform(auth, requestId);
    const aliases = await this.registry.listAliases(id, {
      includeInactive: query.include_inactive === 'true',
    });
    return { aliases: aliases.map(toAliasView) };
  }

  @Get('skills/:id/versions')
  @RequireScopes('platform:skill:read')
  async listSkillVersions(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ versions: VersionView[] }> {
    this.assertPlatform(auth, requestId);
    const versions = await this.registry.listVersions(id);
    return { versions: versions.map(toVersionView) };
  }

  @Get('skills/:id/relationships')
  @RequireScopes('platform:skill:read')
  async listSkillRelationships(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ relationships: RelationshipView[] }> {
    this.assertPlatform(auth, requestId);
    const relationships = await this.registry.listRelationships(id);
    return { relationships: relationships.map(toRelationshipView) };
  }

  @Post('skills')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:skill:manage')
  async createSkill(
    @Body() dto: CreateSkillDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toSkillView(
        await this.registry.createSkill({
          canonicalName: dto.canonical_name,
          description: dto.description ?? null,
          actor: this.actor(auth),
        }),
      ),
    );
  }

  @Patch('skills/:id')
  @RequireScopes('platform:skill:manage')
  async updateSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkillDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toSkillView(
        await this.registry.updateSkill(id, {
          canonicalName: dto.canonical_name,
          description: dto.description,
          actor: this.actor(auth),
        }),
      ),
    );
  }

  @Post('skills/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async deactivateSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => toSkillView(await this.registry.deactivateSkill(id, this.actor(auth))));
  }

  @Post('skills/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async reactivateSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => toSkillView(await this.registry.reactivateSkill(id, this.actor(auth))));
  }

  @Post('skills/:loserId/merge')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async mergeSkill(
    @Param('loserId', ParseUUIDPipe) loserId: string,
    @Body() dto: MergeSkillDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<SkillView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toSkillView(await this.registry.mergeSkill(loserId, dto.winner_skill_id, this.actor(auth))),
    );
  }

  @Post('skills/:id/override')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async overrideSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OverrideSkillDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ ok: true }> {
    this.assertPlatform(auth, requestId);
    const payload: Record<string, string | null> = {
      surface_form: dto.surface_form ?? null,
      reason: dto.reason ?? null,
    };
    await this.run(requestId, () =>
      this.registry.recordCanonicalizationOverride({ subjectId: id, actor: this.actor(auth), payload }),
    );
    return { ok: true };
  }

  // ---- Aliases -----------------------------------------------------------

  @Post('skills/:id/aliases')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:skill:manage')
  async addAlias(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddAliasDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<AliasView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toAliasView(
        await this.registry.addAlias({ skillId: id, alias: dto.alias, aliasType: dto.alias_type, actor: this.actor(auth) }),
      ),
    );
  }

  @Delete('skills/:id/aliases/:aliasId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async removeAlias(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('aliasId', ParseUUIDPipe) aliasId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<AliasView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => toAliasView(await this.registry.removeAlias(aliasId, this.actor(auth))));
  }

  // ---- Versions ----------------------------------------------------------

  @Post('skills/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:skill:manage')
  async addVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddVersionDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<VersionView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toVersionView(
        await this.registry.addVersion({
          skillId: id,
          version: dto.version,
          versionFamily: dto.version_family ?? null,
          actor: this.actor(auth),
        }),
      ),
    );
  }

  @Patch('skills/:id/versions/:versionId')
  @RequireScopes('platform:skill:manage')
  async updateVersion(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: UpdateVersionDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<VersionView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toVersionView(
        await this.registry.updateVersion(versionId, {
          versionFamily: dto.version_family,
          status: dto.status,
          actor: this.actor(auth),
        }),
      ),
    );
  }

  // ---- Relationships -----------------------------------------------------

  @Post('skills/:id/relationships')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:skill:manage')
  async addRelationship(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddRelationshipDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RelationshipView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toRelationshipView(
        await this.registry.addRelationship({
          sourceSkillId: id,
          targetSkillId: dto.target_skill_id,
          relationshipType: dto.relationship_type,
          source: dto.source,
          sourceRef: dto.source_ref ?? null,
          actor: this.actor(auth),
        }),
      ),
    );
  }

  @Delete('skills/:id/relationships/:relationshipId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async removeRelationship(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RelationshipView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toRelationshipView(await this.registry.removeRelationship(relationshipId, this.actor(auth))),
    );
  }

  // ---- Review queue ------------------------------------------------------

  @Get('skill-review-queue')
  @RequireScopes('platform:skill:read')
  async reviewQueueList(
    @Query() query: ReviewQueueQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ rows: Array<{ surface_form: string; occurrence_count: number; tenant_count: number }>; next_cursor: string | null }> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, () =>
      this.reviewQueue.list({
        sourceDomain: query.source_domain,
        minOccurrence: query.min_occurrence,
        surfaceSearch: query.surface_search,
        limit: query.limit ?? 50,
        cursor: query.cursor,
      }),
    );
  }

  // ---- Proposals ---------------------------------------------------------

  @Get('skill-proposals')
  @RequireScopes('platform:skill:read')
  async listProposals(
    @Query() query: ListProposalsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ proposals: ProposalView[] }> {
    this.assertPlatform(auth, requestId);
    const proposals = await this.governance.listProposals({ status: query.status, limit: query.limit ?? 50 });
    return { proposals: proposals.map(toProposalView) };
  }

  @Post('skill-proposals')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:skill:manage')
  async createProposal(
    @Body() dto: CreateProposalDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ProposalView> {
    this.assertPlatform(auth, requestId);
    const proposal = await this.governance.createProposal({
      proposal_type: dto.proposal_type,
      source: dto.source,
      payload: dto.payload,
      proposed_by: auth.sub,
    });
    return toProposalView(proposal);
  }

  @Get('skill-proposals/:id')
  @RequireScopes('platform:skill:read')
  async getProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ProposalView> {
    this.assertPlatform(auth, requestId);
    const proposal = await this.governance.getProposal(id);
    if (proposal === null) {
      throw new AramoError('NOT_FOUND', 'Skill governance proposal not found', 404, { requestId });
    }
    return toProposalView(proposal);
  }

  @Post('skill-proposals/:id/accept')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async acceptProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ProposalView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () => toProposalView(await this.governance.accept(id, this.actor(auth))));
  }

  @Post('skill-proposals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:skill:manage')
  async rejectProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProposalDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ProposalView> {
    this.assertPlatform(auth, requestId);
    return this.run(requestId, async () =>
      toProposalView(await this.governance.reject(id, dto.reason ?? null, this.actor(auth))),
    );
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

  // Translate the skills-taxonomy / review-queue domain errors into the governed
  // AramoError codes. Any untranslated error propagates (→ 500 via the filter).
  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SkillNotFoundError || e instanceof ProposalNotFoundError) {
        throw new AramoError('NOT_FOUND', e.message, 404, { requestId });
      }
      if (e instanceof SkillConflictError) {
        throw new AramoError('SKILL_CONFLICT', e.message, 409, {
          requestId,
          details: { constraint: e.constraint, value: e.value },
        });
      }
      if (e instanceof SkillAliasConflictError) {
        throw new AramoError('SKILL_CONFLICT', e.message, 409, {
          requestId,
          details: { constraint: 'normalized_alias', value: e.normalizedAlias },
        });
      }
      if (e instanceof SkillVersionConflictError) {
        throw new AramoError('SKILL_CONFLICT', e.message, 409, {
          requestId,
          details: { constraint: 'normalized_version', value: e.normalizedVersion },
        });
      }
      if (e instanceof SkillRelationshipConflictError) {
        throw new AramoError('SKILL_CONFLICT', e.message, 409, {
          requestId,
          details: { constraint: 'source_target_type' },
        });
      }
      if (e instanceof ProposalApplyConflictError) {
        throw new AramoError('SKILL_CONFLICT', e.message, 409, {
          requestId,
          details: { constraint: e.constraint },
        });
      }
      if (e instanceof ProposalNotPendingError) {
        throw new AramoError('SKILL_PROPOSAL_NOT_PENDING', e.message, 409, {
          requestId,
          details: { status: e.status },
        });
      }
      if (e instanceof ProposalPayloadError) {
        throw new AramoError('SKILL_PROPOSAL_PAYLOAD_INVALID', e.message, 422, { requestId });
      }
      if (e instanceof SkillValidationError) {
        throw new AramoError('VALIDATION_ERROR', e.message, 400, { requestId });
      }
      if (e instanceof ReviewQueueCursorError) {
        throw new AramoError('VALIDATION_ERROR', e.message, 400, { requestId });
      }
      throw e;
    }
  }
}

// ---- Response views (counts-only / no PII; platform-global skills) ---------

interface SkillView {
  id: string;
  canonical_name: string;
  normalized_name: string;
  description: string | null;
  status: string;
  merged_into_skill_id: string | null;
  created_at: string;
  updated_at: string;
}
interface AliasView {
  id: string;
  skill_id: string;
  alias: string;
  normalized_alias: string;
  alias_type: string;
  status: string;
}
interface VersionView {
  id: string;
  skill_id: string;
  version: string;
  normalized_version: string;
  version_family: string | null;
  status: string;
}
interface RelationshipView {
  id: string;
  source_skill_id: string;
  target_skill_id: string;
  relationship_type: string;
  directionality: string;
  status: string;
  source: string;
  source_ref: string | null;
}
interface ProposalView {
  id: string;
  proposal_type: string;
  source: string;
  status: string;
  payload: unknown;
  proposed_by: string | null;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  applied_entity_id: string | null;
}

function iso(d: Date): string {
  return d.toISOString();
}

function toSkillView(r: {
  id: string;
  canonical_name: string;
  normalized_name: string;
  description: string | null;
  status: string;
  merged_into_skill_id: string | null;
  created_at: Date;
  updated_at: Date;
}): SkillView {
  return {
    id: r.id,
    canonical_name: r.canonical_name,
    normalized_name: r.normalized_name,
    description: r.description,
    status: r.status,
    merged_into_skill_id: r.merged_into_skill_id,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function toAliasView(r: {
  id: string;
  skill_id: string;
  alias: string;
  normalized_alias: string;
  alias_type: string;
  status: string;
}): AliasView {
  return {
    id: r.id,
    skill_id: r.skill_id,
    alias: r.alias,
    normalized_alias: r.normalized_alias,
    alias_type: r.alias_type,
    status: r.status,
  };
}

function toVersionView(r: {
  id: string;
  skill_id: string;
  version: string;
  normalized_version: string;
  version_family: string | null;
  status: string;
}): VersionView {
  return {
    id: r.id,
    skill_id: r.skill_id,
    version: r.version,
    normalized_version: r.normalized_version,
    version_family: r.version_family,
    status: r.status,
  };
}

function toRelationshipView(r: {
  id: string;
  source_skill_id: string;
  target_skill_id: string;
  relationship_type: string;
  directionality: string;
  status: string;
  source: string;
  source_ref: string | null;
}): RelationshipView {
  return {
    id: r.id,
    source_skill_id: r.source_skill_id,
    target_skill_id: r.target_skill_id,
    relationship_type: r.relationship_type,
    directionality: r.directionality,
    status: r.status,
    source: r.source,
    source_ref: r.source_ref,
  };
}

function toProposalView(r: {
  id: string;
  proposal_type: string;
  source: string;
  status: string;
  payload: unknown;
  proposed_by: string | null;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  applied_entity_id: string | null;
}): ProposalView {
  return {
    id: r.id,
    proposal_type: r.proposal_type,
    source: r.source,
    status: r.status,
    payload: r.payload,
    proposed_by: r.proposed_by,
    proposed_at: iso(r.proposed_at),
    decided_by: r.decided_by,
    decided_at: r.decided_at === null ? null : iso(r.decided_at),
    decision_reason: r.decision_reason,
    applied_entity_id: r.applied_entity_id,
  };
}
