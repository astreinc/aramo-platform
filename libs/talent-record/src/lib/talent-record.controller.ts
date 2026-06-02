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
import type { TalentRecordView } from './dto/talent-record.view.js';
import type { UpdateTalentRecordRequestDto } from './dto/update-talent-record-request.dto.js';
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
  constructor(private readonly repo: TalentRecordRepository) {}

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
}
