import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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

import type { AttachmentOwnerType } from './dto/attachment-owner-type.js';
import { isAttachmentOwnerType } from './dto/attachment-owner-type.js';
import type { AttachmentView } from './dto/attachment.view.js';
import type { CreateAttachmentRequestDto } from './dto/create-attachment-request.dto.js';
import { AttachmentRepository } from './attachment.repository.js';

// AttachmentController — PR-A4 Gate 5 ATS Batch 3.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')
//   @RequireScopes('talent:<action>')   // gated under the owner's scope
//   @RequireSiteMatch()
//
// === Scope gating (catalog gap; A3 precedent) ===
//
// `attachment:*` is NOT in the seeded scope catalog. At A4, attachment
// routes are gated under the OWNER's scopes (talent:read for listing /
// reading; talent:edit for attaching / detaching). The recruiter who
// can read/edit a TalentRecord can also see + manage its attachments.
//
// A future identity-seed PR may add `attachment:*` (parallel to the
// requisition:assign carry item recorded at A3). Documented as carry.
//
// At A4 we wire the `talent` owner path ONLY. The repository's
// validateOwner rejects other owner_types with 422 VALIDATION_ERROR
// (the typed discriminator integrity — later batches add the wiring).
@Controller('v1/attachments')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class AttachmentController {
  constructor(private readonly repo: AttachmentRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async listForOwner(
    @AuthContext() authContext: AuthContextType,
    @Query('owner_type') ownerType: string | undefined,
    @Query('owner_id') ownerId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ items: AttachmentView[] }> {
    if (ownerType === undefined || ownerId === undefined) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'owner_type and owner_id query params are required',
        422,
        { requestId, details: { owner_type: ownerType, owner_id: ownerId } },
      );
    }
    if (!isAttachmentOwnerType(ownerType)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Invalid owner_type '${ownerType}'`,
        422,
        { requestId, details: { owner_type: ownerType } },
      );
    }
    const items = await this.repo.listForOwner({
      tenant_id: authContext.tenant_id,
      owner_type: ownerType as AttachmentOwnerType,
      owner_id: ownerId,
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
  ): Promise<AttachmentView> {
    const view = await this.repo.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Attachment not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateAttachmentRequestDto,
    @RequestId() requestId: string,
  ): Promise<AttachmentView> {
    return this.repo.create({
      tenant_id: authContext.tenant_id,
      uploaded_by_id: authContext.sub,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('talent:edit')
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
