import { Injectable } from '@nestjs/common';
import {
  type CreateEnvelopeRequest,
  type EnvelopeSummary,
  type EvidenceSummary,
  type SignatureProviderPort,
} from '@aramo/documents-contracts';
import { EsignRepository, EsignService } from '@aramo/esign';

// DOC-3 §229 — the NATIVE (non-third-party) implementation of the provider-neutral
// SignatureProviderPort, backed by the E-Sign domain (libs/esign). A future
// DocuSign/AdobeSign provider implements the SAME contract without touching this.
@Injectable()
export class NativeAramoSignatureProvider implements SignatureProviderPort {
  constructor(private readonly repo: EsignRepository, private readonly service: EsignService) {}

  private async summarize(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    return {
      envelope_id: full.id,
      status: full.status,
      signers: full.signers.map((s) => ({ signer_id: s.id, email: s.email, status: s.status })),
    };
  }

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary> {
    const env = await this.repo.createEnvelope({
      tenant_id: req.tenant_id,
      subject: req.subject,
      execution_mode: req.execution_mode,
      created_by: req.created_by,
    });
    for (const doc of req.documents) {
      await this.repo.addDocument({ tenant_id: req.tenant_id, envelope_id: env.id, ...doc });
    }
    for (const signer of req.signers) {
      await this.repo.addSigner({ tenant_id: req.tenant_id, envelope_id: env.id, ...signer });
    }
    return this.summarize(req.tenant_id, env.id);
  }

  async sendEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    await this.service.send(tenant_id, envelope_id, env.created_by);
    return this.summarize(tenant_id, envelope_id);
  }

  async getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    return this.summarize(tenant_id, envelope_id);
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string): Promise<EnvelopeSummary> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    await this.service.voidEnvelope(tenant_id, envelope_id, env.created_by, reason);
    return this.summarize(tenant_id, envelope_id);
  }

  async getEvidence(tenant_id: string, envelope_id: string): Promise<EvidenceSummary> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    const signed = await this.service.evidenceManifest(tenant_id, envelope_id);
    return {
      envelope_id,
      status: env.status,
      event_chain_hash: signed.manifest.event_chain_hash,
      signature: signed.signature,
      signature_algorithm: signed.signature_algorithm,
      completed_at: signed.manifest.completed_at,
    };
  }

  // DOC-4 (R-4-7) — the executed-artifact PULL for the Documents write-back.
  // apps/api's idempotent consumer fetches the executed bytes + certificate
  // (base64) then stores the permanent EXECUTED + EXECUTION_CERTIFICATE
  // artifacts. Bytes never traverse the event bus; this authorized read is the
  // only bytes path. Service-to-service (authoritative tenant_id from the caller).
  async getExecutedArtifacts(tenant_id: string, envelope_id: string): Promise<ExecutedArtifactsBundle> {
    const docs = await this.repo.listExecutedDocuments(tenant_id, envelope_id);
    const cert = await this.repo.getExecutionCertificate(tenant_id, envelope_id);
    return {
      envelope_id,
      documents: docs.map((d) => ({
        envelope_document_id: d.envelope_document_id,
        document_ref: d.document_ref,
        document_revision_ref: d.document_revision_ref,
        executed_sha256: d.executed_sha256,
        byte_size: d.byte_size,
        executed_base64: Buffer.from(d.executed_bytes).toString('base64'),
      })),
      certificate:
        cert === null
          ? null
          : {
              certificate_sha256: cert.certificate_sha256,
              byte_size: cert.byte_size,
              certificate_base64: Buffer.from(cert.certificate_bytes).toString('base64'),
            },
    };
  }
}

export interface ExecutedArtifactsBundle {
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
