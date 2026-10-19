import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type {
  CreateEnvelopeRequest,
  EnvelopeSummary,
  EvidenceSummary,
  SignatureActor,
  SignatureProviderPort,
} from '@aramo/documents-contracts';

import { SignApiClient } from './sign-api.client.js';

// Addendum S6 — the Aramo Sign adapter over the AUTHENTICATED Sign API
// (ESIGN_ATS_TRANSPORT=api). Every user-initiated operation acts through the
// recruiter's verified delegation; there is no caller-supplied tenant authority.
// A user operation without an actor credential fails closed (it never falls back
// to the unauthenticated internal path).
export const ESIGN_ATS_TRANSPORT_API = 'api';

export function esignAtsTransport(env: NodeJS.ProcessEnv = process.env): 'internal' | 'api' {
  return env['ESIGN_ATS_TRANSPORT'] === ESIGN_ATS_TRANSPORT_API ? 'api' : 'internal';
}

function actorRequired(): AramoError {
  return new AramoError('ESIGN_SEND_UNAVAILABLE', 'This Aramo Sign action needs the signed-in recruiter', 409, {
    requestId: '',
    details: { reason: 'actor_required' },
  });
}

@Injectable()
export class EsignServiceApiProvider implements SignatureProviderPort {
  constructor(private readonly sign: SignApiClient) {}

  private async grant(tenant_id: string, actor: SignatureActor | undefined) {
    if (actor === undefined) throw actorRequired();
    return this.sign.userGrant(actor, tenant_id);
  }

  async createEnvelope(req: CreateEnvelopeRequest, actor?: SignatureActor): Promise<EnvelopeSummary> {
    const g = await this.grant(req.tenant_id, actor);
    return this.sign.call<EnvelopeSummary>('POST', '/v1/esign/api/envelopes', g, {
      subject: req.subject,
      documents: req.documents.map((d) => ({ ...d })),
      signers: req.signers.map((s) => ({ name: s.name, email: s.email, signing_order: s.signing_order })),
      ...(req.fields !== undefined && req.fields.length > 0 ? { fields: req.fields } : {}),
    });
  }

  async sendEnvelope(tenant_id: string, envelope_id: string, _idempotency_key?: string, actor?: SignatureActor): Promise<EnvelopeSummary> {
    return this.sign.call<EnvelopeSummary>('POST', `/v1/esign/api/envelopes/${encodeURIComponent(envelope_id)}/send`, await this.grant(tenant_id, actor));
  }

  async getEnvelope(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EnvelopeSummary> {
    return this.sign.call<EnvelopeSummary>('GET', `/v1/esign/api/envelopes/${encodeURIComponent(envelope_id)}`, await this.grant(tenant_id, actor));
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string, actor?: SignatureActor): Promise<EnvelopeSummary> {
    return this.sign.call<EnvelopeSummary>('POST', `/v1/esign/api/envelopes/${encodeURIComponent(envelope_id)}/void`, await this.grant(tenant_id, actor), { reason });
  }

  async getEvidence(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EvidenceSummary> {
    return this.sign.call<EvidenceSummary>('GET', `/v1/esign/api/envelopes/${encodeURIComponent(envelope_id)}/evidence`, await this.grant(tenant_id, actor));
  }

  async findEnvelopeForDocument(tenant_id: string, document_ref: string, document_revision_ref: string, actor?: SignatureActor): Promise<EnvelopeSummary | null> {
    const qs = new URLSearchParams({ document_ref, document_revision_ref }).toString();
    const res = await this.sign.call<{ envelope: EnvelopeSummary | null }>('GET', `/v1/esign/api/envelopes/for-document?${qs}`, await this.grant(tenant_id, actor));
    return res.envelope;
  }

  async remindEnvelopeSigner(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EnvelopeSummary> {
    return this.sign.call<EnvelopeSummary>('POST', `/v1/esign/api/envelopes/${encodeURIComponent(envelope_id)}/remind`, await this.grant(tenant_id, actor));
  }

  // D-12 — Sign-owned availability for this recruiter's delegated authority.
  async availability(tenant_id: string, actor: SignatureActor): Promise<{
    available: boolean;
    reason: 'NOT_SUBSCRIBED' | 'LIMIT_REACHED' | null;
    allowance: { limit: number | null; unlimited: boolean; used: number; remaining: number | null; period_start: string; period_end: string; threshold: string } | null;
  }> {
    return this.sign.call('GET', '/v1/esign/api/availability', await this.sign.userGrant(actor, tenant_id));
  }
}
