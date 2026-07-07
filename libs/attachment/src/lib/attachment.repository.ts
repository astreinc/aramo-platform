import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { TalentRecordRepository } from '@aramo/talent-record';

import type { AttachmentOwnerType } from './dto/attachment-owner-type.js';
import type { AttachmentView } from './dto/attachment.view.js';
import type { CreateAttachmentRequestDto } from './dto/create-attachment-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// AttachmentRepository — write + read surface for Attachment.
// Reference CRUD (no metering, no event log).
//
// === Service-layer owner validation (directive §4 ruling) ===
//
// The typed `owner_type` discriminator + owner_id form a polymorphic
// pointer to a row in another PG namespace. Cross-schema FK is
// forbidden (Architecture §7.3), so referential integrity is the
// service's responsibility. At attach time:
//
//   1. Read owner_type (the discriminator).
//   2. Dispatch to the matching repository's tenant-scoped findById.
//   3. Reject with NOT_FOUND when the owner row is absent OR is in
//      a different tenant.
//
// A4 wires + tests the `talent` path ONLY (owner_type=talent →
// TalentRecordRepository.findById). The other 3 owner_types (requisition,
// company, contact) are defined in the enum but REJECTED at the
// validation step with NOT_IMPLEMENTED until later batches wire them in.
// This is the discriminator integrity that exceeds OpenCATS's no-
// constraint untyped blob table.

interface AttachmentRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  storage_key: string;
  is_resume: boolean;
  uploaded_by_id: string | null;
  uploaded_at: Date;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    file_name: row.file_name,
    mime: row.mime,
    size_bytes: row.size_bytes,
    storage_key: row.storage_key,
    is_resume: row.is_resume,
    uploaded_by_id: row.uploaded_by_id,
    uploaded_at: row.uploaded_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class AttachmentRepository {
  private readonly logger = new Logger(AttachmentRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly talentRecordRepository: TalentRecordRepository,
  ) {}

  /**
   * Validate that `owner_id` resolves to an in-tenant row of the type
   * named by `owner_type`. At A4, only the `talent` owner_type is
   * wired; the other three are rejected with VALIDATION_ERROR.
   *
   * Throws on failure; returns void on success.
   */
  private async validateOwner(args: {
    tenant_id: string;
    owner_type: AttachmentOwnerType;
    owner_id: string;
    requestId: string;
  }): Promise<void> {
    switch (args.owner_type) {
      case 'talent': {
        const talent = await this.talentRecordRepository.findById({
          tenant_id: args.tenant_id,
          id: args.owner_id,
        });
        if (talent === null) {
          throw new AramoError(
            'NOT_FOUND',
            'Attachment owner (TalentRecord) not found in tenant',
            404,
            {
              requestId: args.requestId,
              details: {
                owner_type: args.owner_type,
                owner_id: args.owner_id,
              },
            },
          );
        }
        return;
      }
      case 'requisition':
      case 'company':
      case 'contact':
        // The discriminator is defined for these (typed-discriminator
        // integrity — later batches add the wiring without a schema
        // migration). At A4 these are NOT wired.
        throw new AramoError(
          'VALIDATION_ERROR',
          `Attachment owner_type '${args.owner_type}' is defined but not wired at PR-A4`,
          422,
          {
            requestId: args.requestId,
            details: { owner_type: args.owner_type },
          },
        );
    }
  }

  async create(args: {
    tenant_id: string;
    uploaded_by_id: string;
    input: CreateAttachmentRequestDto;
    requestId: string;
  }): Promise<AttachmentView> {
    await this.validateOwner({
      tenant_id: args.tenant_id,
      owner_type: args.input.owner_type,
      owner_id: args.input.owner_id,
      requestId: args.requestId,
    });

    const row = await this.prisma.attachment.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        owner_type: args.input.owner_type,
        owner_id: args.input.owner_id,
        file_name: args.input.file_name,
        mime: args.input.mime,
        size_bytes: args.input.size_bytes,
        storage_key: args.input.storage_key,
        is_resume: args.input.is_resume ?? false,
        uploaded_by_id: args.uploaded_by_id,
      },
    });
    return projectView(row as AttachmentRow);
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<AttachmentView | null> {
    const row = await this.prisma.attachment.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as AttachmentRow);
  }

  async listForOwner(args: {
    tenant_id: string;
    owner_type: AttachmentOwnerType;
    owner_id: string;
  }): Promise<AttachmentView[]> {
    const rows = await this.prisma.attachment.findMany({
      where: {
        tenant_id: args.tenant_id,
        owner_type: args.owner_type,
        owner_id: args.owner_id,
      },
      orderBy: { uploaded_at: 'desc' },
    });
    return (rows as AttachmentRow[]).map(projectView);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Attachment not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.attachment.delete({ where: { id: args.id } });
  }

  // TR-2a-B3b (DDR-3 §4) — OPERATIONAL re-point of the polymorphic talent-record
  // link: move rows whose owner_id == from_record_id AND owner_type ==
  // 'talent' to to_record_id, tenant-scoped. The discriminator filter is
  // load-bearing — a requisition/company/contact row that happens to share the id
  // space is never touched. Idempotent (re-run matches nothing). No unique key on
  // the id column → no collision → removed_rows always [].
  async repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }> {
    const params: unknown[] = [
      args.to_record_id,
      args.from_record_id,
      args.tenant_id,
    ];
    let idFilter = '';
    if (args.only_ids && args.only_ids.length > 0) {
      params.push(args.only_ids);
      idFilter = `AND id = ANY($${params.length}::uuid[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "attachment"."Attachment" SET owner_id = $1::uuid
         WHERE owner_id = $2::uuid AND tenant_id = $3::uuid AND owner_type = 'talent' ${idFilter}
       RETURNING id`,
      ...params,
    );
    return { repointed_ids: rows.map((r) => r.id), removed_rows: [] };
  }
}
