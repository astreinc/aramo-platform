import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort } from './storage/document-storage.port.js';

// DOC-4 (R-4-7) — serves the frozen source PDF bytes that esign-service pulls for
// executed-document production. Reads the revision's prepared artifact (prefers
// RENDERED_UNSIGNED, else SOURCE_UPLOAD) via the DocumentStoragePort. Lives in
// libs/documents so the documents Prisma client model types resolve.

@Injectable()
export class RevisionSourceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
  ) {}

  async getSourceBase64(tenant_id: string, revision_id: string, requestId: string): Promise<string | null> {
    const artifact = await this.prisma.documentArtifact.findFirst({
      where: { tenant_id, revision_id, artifact_role: { in: ['RENDERED_UNSIGNED', 'SOURCE_UPLOAD'] } },
      orderBy: { created_at: 'desc' },
    });
    if (artifact === null) return null;
    const bytes = await this.storage.getArtifact({ storage_key: artifact.storage_locator, requestId, maxBytes: 50 * 1024 * 1024 });
    return Buffer.from(bytes).toString('base64');
  }
}
