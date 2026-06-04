import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
import { ObjectStorageService } from '@aramo/object-storage';

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
//   @RequireScopes('attachment:<action>')
//   @RequireSiteMatch()
//
// === Scope gating (HK-IDENT-SCOPES — proper scopes seeded) ===
//
// Gated on the seeded `attachment:read` / `attachment:create` /
// `attachment:delete` scopes (all recruiter+). `attachment:delete`
// carries a BOUNDED Ruling 1 carve-out: detach is a junction/link
// delete (unlinks a file from its owner), NOT entity destruction;
// the recruiter who attached a file can also detach it.
//
// At A4 we wire the `talent` owner path ONLY. The repository's
// validateOwner rejects other owner_types with 422 VALIDATION_ERROR
// (the typed discriminator integrity — later batches add the wiring).
@Controller('v1/attachments')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class AttachmentController {
  private readonly logger = new Logger(AttachmentController.name);

  constructor(
    private readonly repo: AttachmentRepository,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('attachment:read')
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
  @RequireScopes('attachment:read')
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
  @RequireScopes('attachment:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateAttachmentRequestDto,
    @RequestId() requestId: string,
  ): Promise<AttachmentView> {
    const view = await this.repo.create({
      tenant_id: authContext.tenant_id,
      uploaded_by_id: authContext.sub,
      input: body,
      requestId,
    });

    // A8-3b — Option A orphan-sweep coordination. On successful
    // is_resume=true attach, clear the `lifecycle=orphan-pending` tag
    // baked into the presigned PUT URL at upload time so the S3
    // lifecycle Rule 5 does not sweep this committed résumé.
    //
    // Failure semantics: the tag-clear is NOT transactional with the
    // Attachment row. If it fails, the row is still valid (correctly
    // points at the S3 object); the worst case is the object is swept
    // in 24h, recoverable via the noncurrent-version retention window.
    // Log + continue, do NOT throw -- request-failure here would
    // confuse the recruiter ("did the attach succeed?") and the answer
    // is YES.
    if (view.is_resume) {
      try {
        await this.objectStorage.markResumeCommitted({
          storage_key: view.storage_key,
          requestId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `attachment.mark_committed_failed: request=${requestId} attachment=${view.id} storage_key=${view.storage_key} -- ${message}`,
        );
      }
    }

    return view;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('attachment:delete')
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
