import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { ResumeAttachmentResolver } from '@aramo/talent-record';

import { AttachmentRepository } from './attachment.repository.js';

// TALENT-INTEL-1 (TI-1B, ruling 15) — the CONCRETE implementation of the
// talent-record ResumeAttachmentResolver PORT for the EDIT/re-extraction
// (ATTACHMENT) source form.
//
// Placement rationale: `attachment → talent-record` is an established edge
// (AttachmentRepository → TalentRecordRepository); the reverse would cycle. So
// the résumé-extraction orchestrator (in talent-record) depends on the PORT,
// and this concrete resolver — which owns AttachmentRepository — lives here and
// is bound to RESUME_ATTACHMENT_RESOLVER at the composition layer.
//
// It resolves an OWNED attachment_id to its storage_key ONLY after verifying,
// against the tenant-scoped attachment row:
//   - the attachment exists IN the authenticated tenant, and
//   - owner_type = 'talent' AND owner_id = the expected Talent, and
//   - is_resume = true.
// Any failure → RESUME_SOURCE_UNAUTHORIZED (403), before the caller touches
// object storage. The client never supplies the authoritative storage_key.
@Injectable()
export class AttachmentResumeResolver implements ResumeAttachmentResolver {
  constructor(private readonly attachments: AttachmentRepository) {}

  async resolveOwnedResumeStorageKey(input: {
    attachment_id: string;
    talent_id: string;
    tenant_id: string;
    requestId: string;
  }): Promise<{ storage_key: string }> {
    const row = await this.resolveOwnedRow(input);
    return { storage_key: row.storage_key };
  }

  // TALENT-INTEL-1 TI-1D-C — the same tenant + Talent ownership + is_resume gate,
  // returning the metadata an edition ingestion needs to mint its TalentDocument.
  async resolveOwnedResume(input: {
    attachment_id: string;
    talent_id: string;
    tenant_id: string;
    requestId: string;
  }): Promise<{
    storage_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }> {
    const row = await this.resolveOwnedRow(input);
    return {
      storage_key: row.storage_key,
      filename: row.file_name,
      mime_type: row.mime,
      size_bytes: row.size_bytes,
    };
  }

  private async resolveOwnedRow(input: {
    attachment_id: string;
    talent_id: string;
    tenant_id: string;
    requestId: string;
  }) {
    const row = await this.attachments.findById({
      tenant_id: input.tenant_id,
      id: input.attachment_id,
    });
    if (row === null) {
      // Absent in-tenant (includes cross-tenant ids, which findById scopes out).
      throw this.unauthorized(input.requestId, 'attachment_not_found_in_tenant');
    }
    if (row.owner_type !== 'talent' || row.owner_id !== input.talent_id) {
      // Owned by a different Talent (or a non-talent owner). Talent binding fails.
      throw this.unauthorized(input.requestId, 'talent_ownership_mismatch');
    }
    if (row.is_resume !== true) {
      // A non-résumé attachment is not an authorized extraction source.
      throw this.unauthorized(input.requestId, 'not_a_resume_attachment');
    }
    return row;
  }

  private unauthorized(requestId: string, reason: string): AramoError {
    return new AramoError(
      'RESUME_SOURCE_UNAUTHORIZED',
      'résumé source is not authorized for this request',
      403,
      { requestId, details: { reason } },
    );
  }
}
