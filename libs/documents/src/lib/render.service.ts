import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  DOCUMENT_RENDERING_PORT,
  type DocumentRenderingPort,
  type RenderModel,
} from '@aramo/documents-rendering';

import { PrismaService } from './prisma/prisma.service.js';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort } from './storage/document-storage.port.js';
import { DocumentNotFoundError } from './domain/errors.js';

// DOC-2 boundary 5 — render orchestration. Ties the DocumentRenderingPort
// (GENERATED path) to the Documents aggregate: render -> store bytes ->
// persist a FROZEN DocumentRevision + a RENDERED_UNSIGNED DocumentArtifact in
// ONE $transaction, populating render_manifest with the provenance record.
// Fail-closed: a render/storage failure throws BEFORE any DB write, so no
// authoritative prepared revision is created (acceptance R-2-4/#10).

export interface GenerateRevisionInput {
  tenant_id: string;
  document_id: string;
  template_version_id?: string;
  model: RenderModel;
  actor_id: string;
  requestId: string;
}

export interface GenerateRevisionResult {
  revision_id: string;
  artifact_id: string;
  revision_number: number;
  sha256: string;
  storage_locator: string;
}

@Injectable()
export class RenderService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_RENDERING_PORT) private readonly renderer: DocumentRenderingPort,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
  ) {}

  async generateRevision(input: GenerateRevisionInput): Promise<GenerateRevisionResult> {
    // Tenant-scoped existence check (cross-tenant => NOT FOUND).
    const doc = await this.prisma.document.findFirst({
      where: { tenant_id: input.tenant_id, id: input.document_id },
    });
    if (doc === null) throw new DocumentNotFoundError(input.document_id);

    // 1. Render (Job 2) — throws RenderFailedError on failure, before any write.
    const out = await this.renderer.renderGenerated(input.model);

    // 2. Persist bytes via the storage port (content-addressed key).
    const storageKey = `documents/${input.tenant_id}/${input.document_id}/rendered/${out.sha256}.pdf`;
    await this.storage.putArtifact({
      storage_key: storageKey,
      body: Buffer.from(out.bytes),
      content_type: 'application/pdf',
      requestId: input.requestId,
    });

    // 3. One transaction: FROZEN revision + RENDERED_UNSIGNED artifact.
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.documentRevision.findFirst({
        where: { tenant_id: input.tenant_id, document_id: input.document_id },
        orderBy: { revision_number: 'desc' },
      });
      const revisionNumber = (last?.revision_number ?? 0) + 1;
      const revisionId = randomUUID();
      await tx.documentRevision.create({
        data: {
          id: revisionId,
          tenant_id: input.tenant_id,
          document_id: input.document_id,
          revision_number: revisionNumber,
          template_version_id: input.template_version_id ?? null,
          render_manifest: { model: input.model, provenance: out.provenance } as never,
          content_sha256: out.sha256,
          mime_type: 'application/pdf',
          byte_size: out.bytes.byteLength,
          status: 'FROZEN',
          created_by: input.actor_id,
          frozen_at: new Date(),
        },
      });
      const artifactId = randomUUID();
      await tx.documentArtifact.create({
        data: {
          id: artifactId,
          tenant_id: input.tenant_id,
          revision_id: revisionId,
          document_id: input.document_id,
          artifact_role: 'RENDERED_UNSIGNED',
          storage_provider: 'aramo-s3',
          storage_locator: storageKey,
          mime_type: 'application/pdf',
          byte_size: out.bytes.byteLength,
          sha256: out.sha256,
          immutability_state: 'FROZEN',
          retention_class: 'DOCUMENT_RENDER',
          created_by: input.actor_id,
        },
      });
      return {
        revision_id: revisionId,
        artifact_id: artifactId,
        revision_number: revisionNumber,
        sha256: out.sha256,
        storage_locator: storageKey,
      };
    });
  }
}
