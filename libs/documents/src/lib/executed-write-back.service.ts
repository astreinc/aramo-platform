import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort } from './storage/document-storage.port.js';
import { DocumentIdempotencyService } from './idempotency.service.js';
import { DocumentNotFoundError, ExecutedArtifactHashMismatchError } from './domain/errors.js';

// DOC-4 (R-4-7) — the Documents write-back. apps/api's idempotent consumer, on an
// executed-envelope event, PULLS executed bytes + certificate from esign-service
// and calls this to store the permanent EXECUTED + EXECUTION_CERTIFICATE
// artifacts, verify integrity hashes, and transition Document -> EXECUTED. This
// is the SOLE writer of those artifact roles (esign-service never writes the
// documents schema — DOC-3 boundary-b). Idempotent: replaying the same executed
// event never creates duplicate legal/evidence records (§286, invariant 16).

export interface StoreExecutedInput {
  tenant_id: string;
  document_id: string;
  revision_id: string;
  executed_bytes: Buffer;
  executed_sha256: string;
  certificate_bytes: Buffer;
  certificate_sha256: string;
  actor_id: string;
  requestId: string;
  idempotency_key: string;
  correlation_id?: string;
}

export interface StoreExecutedResult {
  executed_artifact_id: string;
  certificate_artifact_id: string;
  document_status: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

@Injectable()
export class DocumentExecutedWriteBackService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
    private readonly idempotency: DocumentIdempotencyService,
  ) {}

  async storeExecuted(input: StoreExecutedInput): Promise<StoreExecutedResult> {
    // 1. Integrity — never store bytes that do not match the asserted hash.
    if (sha256Hex(input.executed_bytes) !== input.executed_sha256) {
      throw new ExecutedArtifactHashMismatchError('EXECUTED');
    }
    if (sha256Hex(input.certificate_bytes) !== input.certificate_sha256) {
      throw new ExecutedArtifactHashMismatchError('EXECUTION_CERTIFICATE');
    }

    // 2. Tenant-scoped existence (cross-tenant => NOT FOUND).
    const doc = await this.prisma.document.findFirst({ where: { tenant_id: input.tenant_id, id: input.document_id } });
    if (doc === null) throw new DocumentNotFoundError(input.document_id);

    // 3. Idempotency pre-check (committed state).
    const request_hash = DocumentIdempotencyService.hashRequest({
      revision_id: input.revision_id,
      executed_sha256: input.executed_sha256,
      certificate_sha256: input.certificate_sha256,
    });
    const pre = await this.idempotency.lookup(input.tenant_id, input.idempotency_key, request_hash);
    if (pre.kind === 'replay') return pre.response_body as StoreExecutedResult;
    if (pre.kind === 'conflict') {
      const { DocumentIdempotencyConflictError } = await import('./domain/errors.js');
      throw new DocumentIdempotencyConflictError(input.idempotency_key);
    }

    // 4. Store bytes via the storage port (content-addressed) BEFORE the DB write.
    const executedKey = `documents/${input.tenant_id}/${input.document_id}/executed/${input.executed_sha256}.pdf`;
    const certKey = `documents/${input.tenant_id}/${input.document_id}/certificate/${input.certificate_sha256}.pdf`;
    await this.storage.putArtifact({ storage_key: executedKey, body: input.executed_bytes, content_type: 'application/pdf', requestId: input.requestId });
    await this.storage.putArtifact({ storage_key: certKey, body: input.certificate_bytes, content_type: 'application/pdf', requestId: input.requestId });

    // 5. One transaction: EXECUTED + EXECUTION_CERTIFICATE artifacts + status +
    //    event + consumed idempotency key. A P2002 on the key => concurrent
    //    replay; re-lookup and return the stored result.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const executedArtifactId = randomUUID();
        const certificateArtifactId = randomUUID();
        await tx.documentArtifact.create({
          data: {
            id: executedArtifactId, tenant_id: input.tenant_id, revision_id: input.revision_id, document_id: input.document_id,
            artifact_role: 'EXECUTED', storage_provider: 'aramo-s3', storage_locator: executedKey,
            mime_type: 'application/pdf', byte_size: input.executed_bytes.byteLength, sha256: input.executed_sha256,
            immutability_state: 'FROZEN', retention_class: 'DOCUMENT_EXECUTED', created_by: input.actor_id,
          },
        });
        await tx.documentArtifact.create({
          data: {
            id: certificateArtifactId, tenant_id: input.tenant_id, revision_id: input.revision_id, document_id: input.document_id,
            artifact_role: 'EXECUTION_CERTIFICATE', storage_provider: 'aramo-s3', storage_locator: certKey,
            mime_type: 'application/pdf', byte_size: input.certificate_bytes.byteLength, sha256: input.certificate_sha256,
            immutability_state: 'FROZEN', retention_class: 'DOCUMENT_CERTIFICATE', created_by: input.actor_id,
          },
        });
        await tx.document.update({ where: { id: input.document_id }, data: { status: 'EXECUTED', current_revision_id: input.revision_id } });
        await tx.documentEvent.create({
          data: {
            id: randomUUID(), tenant_id: input.tenant_id, document_id: input.document_id, revision_id: input.revision_id,
            event_type: 'DOCUMENT_EXECUTED', actor_type: 'SYSTEM', actor_id: input.actor_id,
            correlation_id: input.correlation_id ?? null, request_id: input.requestId,
            payload: { executed_sha256: input.executed_sha256, certificate_sha256: input.certificate_sha256 },
          },
        });
        const result: StoreExecutedResult = {
          executed_artifact_id: executedArtifactId,
          certificate_artifact_id: certificateArtifactId,
          document_status: 'EXECUTED',
        };
        await tx.idempotencyKey.create({
          data: { id: randomUUID(), tenant_id: input.tenant_id, key: input.idempotency_key, request_hash, response_status: 201, response_body: result as never },
        });
        return result;
      });
    } catch (e) {
      if (DocumentIdempotencyService.isUniqueViolation(e)) {
        const post = await this.idempotency.lookup(input.tenant_id, input.idempotency_key, request_hash);
        if (post.kind === 'replay') return post.response_body as StoreExecutedResult;
      }
      throw e;
    }
  }
}
