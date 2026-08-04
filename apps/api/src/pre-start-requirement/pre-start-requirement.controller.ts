import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  DefinitionSetRepository,
  RequirementInstanceRepository,
  type InstanceView,
} from '@aramo/pre-start-requirement';

import { CreateDraftSetDto, EditDraftSetDto, ReopenDto, StatusMoveDto, WaiveDto } from './dto/pre-start-requirement.dto.js';
import { PlacementReadinessService } from './placement-readiness.service.js';
import { PreStartWaiverService } from './pre-start-waiver.service.js';

const READ_RESTRICTED_EVIDENCE_SCOPE = 'pre_start_requirement:read_restricted_evidence';

// Track 3 / E2 — the guarded HTTP surface. Every route is scope-gated (RolesGuard
// requires a superset of @RequireScopes). scope is server-derived TENANT-only
// (§4b): the tenant comes from the JWT, never the body. Domain refusals surface as
// AramoError envelopes (PRE_START_REQUIREMENT_INVALID / PRE_START_NOT_READY /
// INSUFFICIENT_PERMISSIONS); raw Postgres exceptions are never returned.
@Controller('v1/pre-start-requirement')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class PreStartRequirementController {
  constructor(
    private readonly sets: DefinitionSetRepository,
    private readonly requirements: RequirementInstanceRepository,
    private readonly readiness: PlacementReadinessService,
    private readonly waivers: PreStartWaiverService,
  ) {}

  // ---- Definition sets (configure / publish) ----------------------------------

  @Post('sets')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('pre_start_requirement:configure')
  async createDraft(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Body() body: CreateDraftSetDto,
  ) {
    return this.sets.createDraft(
      {
        tenant_id: auth.tenant_id,
        scope: 'TENANT',
        scope_ref_id: auth.tenant_id,
        version: body.version,
        definitions: body.definitions.map((d) => ({
          requirement_type: d.requirement_type as never,
          label: d.label,
          blocking: d.blocking,
          owner_role: d.owner_role ?? null,
          sequence: d.sequence,
          waiver_mode: d.waiver_mode as never,
        })),
      },
      requestId,
    );
  }

  @Put('sets/:setId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:configure')
  async editDraft(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body() body: EditDraftSetDto,
  ) {
    return this.sets.editDraft(
      {
        tenant_id: auth.tenant_id,
        set_id: setId,
        definitions: body.definitions.map((d) => ({
          requirement_type: d.requirement_type as never,
          label: d.label,
          blocking: d.blocking,
          owner_role: d.owner_role ?? null,
          sequence: d.sequence,
          waiver_mode: d.waiver_mode as never,
        })),
      },
      requestId,
    );
  }

  @Post('sets/:setId/publish')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:publish')
  async publish(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
  ) {
    return this.sets.publish({ tenant_id: auth.tenant_id, set_id: setId, published_by: auth.sub }, requestId);
  }

  @Get('sets/applicable')
  @RequireScopes('pre_start_requirement:read')
  async resolveApplicable(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.sets.resolveApplicable(
      auth.tenant_id,
      { scope: 'TENANT', scope_ref_id: auth.tenant_id },
      requestId,
    );
  }

  // ---- Instances (read / act / waive) -----------------------------------------

  @Get('placements/:placementId/requirements')
  @RequireScopes('pre_start_requirement:read')
  async listForPlacement(
    @AuthContext() auth: AuthContextType,
    @Param('placementId', ParseUUIDPipe) placementId: string,
  ) {
    const assessment = await this.requirements.assessBlocking(auth.tenant_id, placementId);
    const instances = await this.requirements.findByPlacement(auth.tenant_id, placementId);
    const canReadRestricted = auth.scopes.includes(READ_RESTRICTED_EVIDENCE_SCOPE);
    return {
      materialized: assessment.materialized,
      ready: assessment.ready,
      blocking_unresolved_count: assessment.unresolved_blocking.length,
      requirements: instances.map((i) => this.redactEvidence(i, canReadRestricted)),
    };
  }

  @Post('requirements/:instanceId/status')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:act')
  async statusMove(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() body: StatusMoveDto,
  ) {
    const canReadRestricted = auth.scopes.includes(READ_RESTRICTED_EVIDENCE_SCOPE);
    const updated = await this.requirements.applyStatusMove(
      {
        tenant_id: auth.tenant_id,
        requirement_instance_id: instanceId,
        to: body.to as never,
        actor_id: auth.sub,
        actor_type: auth.actor_kind,
        reason: body.reason,
        justification: body.justification,
        source: body.source,
        completed_by: body.completed_by ?? auth.sub,
        evidence_reference: body.evidence_reference,
      },
      requestId,
    );
    return this.redactEvidence(updated, canReadRestricted);
  }

  // Reopen — a PRIVILEGED audited action returning a resolved/failed instance to
  // PENDING. Its OWN route + scope (pre_start_requirement:reopen, zero default
  // grants, §13-R). Deliberately NOT reachable from the :act status route — every
  // recruiter holding :act must not be able to undo a compliance outcome.
  @Post('requirements/:instanceId/reopen')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:reopen')
  async reopen(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() body: ReopenDto,
  ) {
    const canReadRestricted = auth.scopes.includes(READ_RESTRICTED_EVIDENCE_SCOPE);
    const updated = await this.requirements.applyStatusMove(
      {
        tenant_id: auth.tenant_id,
        requirement_instance_id: instanceId,
        to: 'PENDING',
        actor_id: auth.sub,
        actor_type: auth.actor_kind,
        justification: body.justification,
        source: body.source,
      },
      requestId,
    );
    return this.redactEvidence(updated, canReadRestricted);
  }

  // Waiver — the RBAC floor (blocking -> waive_blocking, advisory -> waive_advisory)
  // is decided in the service (data-dependent), then the domain NOT_WAIVABLE floor.
  // The route requires the base 'act' scope; the specific waiver authority is the
  // additional data-dependent floor.
  @Post('requirements/:instanceId/waive')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:act')
  async waive(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() body: WaiveDto,
  ) {
    const canReadRestricted = auth.scopes.includes(READ_RESTRICTED_EVIDENCE_SCOPE);
    const updated = await this.waivers.waive(
      auth,
      instanceId,
      { authority: body.authority, justification: body.justification, source: body.source },
      requestId,
    );
    return this.redactEvidence(updated, canReadRestricted);
  }

  // ---- Readiness gate (act) ----------------------------------------------------

  @Post('placements/:placementId/ready')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pre_start_requirement:act')
  async markReady(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('placementId', ParseUUIDPipe) placementId: string,
  ) {
    return this.readiness.markReadyToStart({ tenant_id: auth.tenant_id, placement_process_id: placementId }, requestId);
  }

  // evidence_reference is a restricted pointer (§4d). Redacted unless the caller
  // holds pre_start_requirement:read_restricted_evidence (ZERO default grants).
  private redactEvidence(i: InstanceView, canRead: boolean): Omit<InstanceView, 'evidence_reference'> & {
    evidence_reference: string | null;
    evidence_restricted: boolean;
  } {
    const restricted = i.evidence_reference !== null && !canRead;
    return {
      ...i,
      evidence_reference: restricted ? null : i.evidence_reference,
      evidence_restricted: restricted,
    };
  }
}
