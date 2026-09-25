import { Injectable } from '@nestjs/common';
import { DocumentExecutedWriteBackService } from '@aramo/documents';

// DOC-4 (R-4-7) — the apps/api side of the executed-artifact write-back seam.
//   EsignExecutedArtifactsClient — pulls executed bytes + certificate FROM
//                               esign-service (bytes never traverse the bus).
//   EsignWriteBackOrchestrator — on an executed event, pulls then calls the
//                               DocumentExecutedWriteBackService (the sole writer
//                               of EXECUTED / EXECUTION_CERTIFICATE artifacts).
// RevisionSourceService lives in @aramo/documents (documents client types).

export const DOCUMENTS_ESIGN_PRISMA = 'DOCUMENTS_ESIGN_PRISMA';

interface ExecutedArtifactsBundle {
  envelope_id: string;
  documents: {
    envelope_document_id: string;
    document_ref: string | null;
    document_revision_ref: string | null;
    executed_sha256: string;
    byte_size: number;
    executed_base64: string;
  }[];
  certificate: { certificate_sha256: string; byte_size: number; certificate_base64: string } | null;
}

@Injectable()
export class EsignExecutedArtifactsClient {
  private baseUrl(): string {
    return process.env['ESIGN_SERVICE_URL'] ?? 'http://localhost:3003';
  }

  async fetchExecuted(tenant_id: string, envelope_id: string): Promise<ExecutedArtifactsBundle> {
    const url = `${this.baseUrl()}/v1/esign/envelopes/${envelope_id}/executed?tenant_id=${encodeURIComponent(tenant_id)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`esign executed pull failed for envelope ${envelope_id}: HTTP ${res.status}`);
    return (await res.json()) as ExecutedArtifactsBundle;
  }
}

export interface WriteBackResult {
  envelope_id: string;
  documents_written: number;
}

@Injectable()
export class EsignWriteBackOrchestrator {
  constructor(
    private readonly client: EsignExecutedArtifactsClient,
    private readonly writeBack: DocumentExecutedWriteBackService,
  ) {}

  // Idempotent: replaying the same executed event stores nothing new (the
  // write-back service dedups on (tenant, idempotency_key)).
  async writeBackEnvelope(input: { tenant_id: string; envelope_id: string; correlation_id?: string; requestId: string }): Promise<WriteBackResult> {
    const bundle = await this.client.fetchExecuted(input.tenant_id, input.envelope_id);
    if (bundle.certificate === null) throw new Error(`envelope ${input.envelope_id} has no execution certificate`);
    let written = 0;
    for (const doc of bundle.documents) {
      if (doc.document_ref === null || doc.document_revision_ref === null) continue;
      await this.writeBack.storeExecuted({
        tenant_id: input.tenant_id,
        document_id: doc.document_ref,
        revision_id: doc.document_revision_ref,
        executed_bytes: Buffer.from(doc.executed_base64, 'base64'),
        executed_sha256: doc.executed_sha256,
        certificate_bytes: Buffer.from(bundle.certificate.certificate_base64, 'base64'),
        certificate_sha256: bundle.certificate.certificate_sha256,
        actor_id: input.tenant_id, // system actor for the service-driven write-back
        requestId: input.requestId,
        idempotency_key: `esign-writeback:${input.envelope_id}:${doc.envelope_document_id}`,
        correlation_id: input.correlation_id,
      });
      written += 1;
    }
    return { envelope_id: input.envelope_id, documents_written: written };
  }
}
