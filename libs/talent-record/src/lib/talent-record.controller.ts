import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import { LinkTalentRecordRequestDto } from './dto/link-talent-record-request.dto.js';
import type { TalentLinkView } from './dto/talent-link.view.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import type { UpdateTalentRecordRequestDto } from './dto/update-talent-record-request.dto.js';
import { TalentLinkService } from './talent-link.service.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// TalentRecordController — PR-A4 Gate 5 ATS Batch 3.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes('talent:<action>')   // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// Reuses the existing seeded `talent:*` scopes (read/create/edit/delete)
// per the directive amendment — the scope catalog is unchanged; the
// rename is at the lib + namespace + entity name level only.
//
// Recruiter divergence (Ruling 1): delete → `talent:delete` (tenant_admin
// only per the seeded catalog).
//
// NO assignment filter: TalentRecord is tenant + site scoped; visible to
// all entitled + scoped recruiters in the tenant. (Unlike requisition,
// which gates per-row by RequisitionAssignment.)
@Controller('v1/talent-records')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentRecordController {
  constructor(
    private readonly repo: TalentRecordRepository,
    private readonly linkService: TalentLinkService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: TalentRecordView[] }> {
    const items = await this.repo.list({
      tenant_id: authContext.tenant_id,
      site_id: siteIdFromQuery,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    const view = await this.repo.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateTalentRecordRequestDto,
  ): Promise<TalentRecordView> {
    return this.repo.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateTalentRecordRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    return this.repo.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('talent:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.repo.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // PR-A5b-2 — Core-Talent link routes (the keystone).
  //
  // Scope reuse: the existing seeded `talent:read` / `talent:edit`
  // scopes cover the read / write surface naturally. A dedicated
  // `talent:link` scope was considered but not warranted — linking is
  // a per-record edit (the route shape and the data shape both fit
  // under `talent:edit`'s authority), and consolidating reduces the
  // scope-catalog churn at the keystone. If Gate 5 finds otherwise,
  // a dedicated scope can be added without rewriting the routes.
  //
  // SACRED BOUNDARIES (enforced by TalentLinkService):
  //   - LINK-NOT-CREATE — never mutates Core.
  //   - ASSOCIATE-NOT-RESOLVE — core_talent_id is an explicit input.
  // -------------------------------------------------------------------------

  @Get(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async getLink(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.getLink({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      requestId,
    });
  }

  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async link(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: LinkTalentRecordRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.link({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      core_talent_id: body.core_talent_id,
      requestId,
    });
  }

  @Delete(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async unlink(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.unlink({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      requestId,
    });
  }
}
