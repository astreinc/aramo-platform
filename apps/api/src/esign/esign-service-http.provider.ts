import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type ErrorCode } from '@aramo/common';
import {
  type CreateEnvelopeRequest,
  type EnvelopeSummary,
  type EvidenceSummary,
  type SignatureProviderPort,
} from '@aramo/documents-contracts';

// DOC-3 B5c — the concrete HTTP adapter binding SignatureProviderPort to the
// separate apps/esign-service backend. apps/api reaches E-Sign ONLY through this
// port over HTTP — NEVER via a direct esign-schema/Prisma import (hard boundary,
// directive R-3-6b). Idempotency + correlation propagate as headers. A future
// DocuSign/Adobe adapter implements the same port without touching apps/api's
// callers (RTR/Offer are DOC-5/6).
@Injectable()
export class EsignServiceHttpProvider implements SignatureProviderPort {
  private readonly logger = new Logger('EsignServiceHttpProvider');
  private readonly baseUrl = process.env['ESIGN_SERVICE_URL'] ?? 'http://localhost:3003';

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } }).error;
      const code = (err?.code ?? 'INTERNAL_ERROR') as ErrorCode;
      // requestId is filled by the AramoExceptionFilter from the live request
      // context; the adapter carries an empty placeholder.
      throw new AramoError(code, err?.message ?? 'esign-service error', res.status, { requestId: '' });
    }
    return json as T;
  }

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary> {
    const headers = req.idempotency_key ? { 'idempotency-key': req.idempotency_key } : undefined;
    return this.call<EnvelopeSummary>('POST', '/v1/esign/envelopes', req, headers);
  }

  async sendEnvelope(tenant_id: string, envelope_id: string, idempotency_key?: string): Promise<EnvelopeSummary> {
    const headers = idempotency_key ? { 'idempotency-key': idempotency_key } : undefined;
    return this.call<EnvelopeSummary>('POST', `/v1/esign/envelopes/${envelope_id}/send`, { tenant_id }, headers);
  }

  async getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    return this.call<EnvelopeSummary>('GET', `/v1/esign/envelopes/${envelope_id}?tenant_id=${encodeURIComponent(tenant_id)}`);
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string): Promise<EnvelopeSummary> {
    return this.call<EnvelopeSummary>('POST', `/v1/esign/envelopes/${envelope_id}/void`, { tenant_id, reason });
  }

  async getEvidence(tenant_id: string, envelope_id: string): Promise<EvidenceSummary> {
    return this.call<EvidenceSummary>('GET', `/v1/esign/envelopes/${envelope_id}/evidence?tenant_id=${encodeURIComponent(tenant_id)}`);
  }
}
