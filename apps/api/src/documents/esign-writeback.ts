import { Injectable } from '@nestjs/common';
import { DocumentExecutedWriteBackService } from '@aramo/documents';

import { SignApiClient } from '../sign/sign-api.client.js';

// DOC-4 (R-4-7) — the apps/api side of the executed-artifact write-back seam.
//   EsignExecutedArtifactsClient — pulls executed bytes + certificate FROM
//                               sign-service (bytes never traverse the bus).
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
  constructor(private readonly sign: SignApiClient) {}

  // Addendum S6 ruling 1 — over the Sign API transport there is no recruiter: the
  // ATS authenticates as its own first-party client and presents the completion
  // event it was delivered; Sign returns a five-minute read grant for exactly this
  // envelope. Without the event the pull is refused. The unauthenticated internal
  // pull is retired (Domain Isolation V1 §3 H-2).
  async fetchExecuted(tenant_id: string, envelope_id: string, event_id?: string): Promise<ExecutedArtifactsBundle> {
    if (event_id === undefined) throw new Error(`esign executed pull for envelope ${envelope_id} needs its completion event`);
    const grant = await this.sign.eventGrant(event_id, tenant_id, envelope_id);
    return this.sign.call<ExecutedArtifactsBundle>('GET', `/v1/sign/api/envelopes/${encodeURIComponent(envelope_id)}/executed`, grant);
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
  async writeBackEnvelope(input: { tenant_id: string; envelope_id: string; correlation_id?: string; event_id?: string; requestId: string }): Promise<WriteBackResult> {
    const bundle = await this.client.fetchExecuted(input.tenant_id, input.envelope_id, input.event_id);
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
