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
}
