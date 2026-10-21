import { Injectable } from '@nestjs/common';
import { AramoError, type ErrorCode } from '@aramo/common';
import {
  SIGN_TEMPLATE_BODY_DIGEST_PARAM,
  SIGN_TEMPLATE_LIBRARY_PATH,
  signEsignServiceRequest,
  signTemplateBodyDigest,
  type SignTemplateListResponse,
  type SignTemplatePreviewRequest,
  type SignTemplatePreviewResponse,
  type SignTemplateRenderRequest,
  type SignTemplateRenderResponse,
} from '@aramo/documents-contracts';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7 (ADR-0034 D12). The
// ONLY way Aramo Sign reaches the shared template library: the Documents API over the
// signed service-to-service channel (aramo-sign-s2s-v1, keyed by
// SIGN_WEBHOOK_SIGNING_SECRET — the same channel as DocumentSourceHttpAdapter). Sign never
// reads or writes the documents schema; the render (a Document + frozen DocumentRevision)
// is performed by apps/api. A POST body is bound through the signed `body_sha256` query
// parameter. Fail closed: without the secret no request is sent.
//
// A typed refusal from apps/api ({ error: { code, message, details } }) is passed through
// with its status, so the sender sees the real reason (e.g. a template field missing).

export const DOCUMENT_TEMPLATES_PORT = 'DOCUMENT_TEMPLATES_PORT';

export interface DocumentTemplatesPort {
  list(input: { tenant_id: string; requestId: string }): Promise<SignTemplateListResponse>;
  preview(input: { tenant_id: string; template_id: string; body: SignTemplatePreviewRequest; requestId: string }): Promise<SignTemplatePreviewResponse>;
  render(input: {
    tenant_id: string;
    template_id: string;
    idempotency_key: string;
    body: SignTemplateRenderRequest;
    requestId: string;
  }): Promise<SignTemplateRenderResponse>;
}

@Injectable()
export class DocumentTemplatesHttpAdapter implements DocumentTemplatesPort {
  private baseUrl(): string {
    return process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
  }

  async list(input: { tenant_id: string; requestId: string }): Promise<SignTemplateListResponse> {
    const q = new URLSearchParams({ tenant_id: input.tenant_id });
    return this.call<SignTemplateListResponse>('GET', `${SIGN_TEMPLATE_LIBRARY_PATH}?${q.toString()}`, undefined, input.requestId);
  }

  async preview(input: { tenant_id: string; template_id: string; body: SignTemplatePreviewRequest; requestId: string }): Promise<SignTemplatePreviewResponse> {
    const q = new URLSearchParams({ tenant_id: input.tenant_id, [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: signTemplateBodyDigest(input.body) });
    return this.call<SignTemplatePreviewResponse>(
      'POST',
      `${SIGN_TEMPLATE_LIBRARY_PATH}/${encodeURIComponent(input.template_id)}/preview?${q.toString()}`,
      input.body,
      input.requestId,
    );
  }

  async render(input: {
    tenant_id: string;
    template_id: string;
    idempotency_key: string;
    body: SignTemplateRenderRequest;
    requestId: string;
  }): Promise<SignTemplateRenderResponse> {
    const q = new URLSearchParams({
      tenant_id: input.tenant_id,
      idempotency_key: input.idempotency_key,
      [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: signTemplateBodyDigest(input.body),
    });
    return this.call<SignTemplateRenderResponse>(
      'POST',
      `${SIGN_TEMPLATE_LIBRARY_PATH}/${encodeURIComponent(input.template_id)}/render?${q.toString()}`,
      input.body,
      input.requestId,
    );
  }

  private async call<T>(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, requestId: string): Promise<T> {
    const secret = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    if (secret === undefined || secret.length === 0) {
      throw new AramoError('ESIGN_SERVICE_AUTH_UNAVAILABLE', 'templates are unavailable: sign-service requests to Documents are not configured', 503, {
        requestId,
      });
    }
    const url = `${this.baseUrl()}${pathAndQuery}`;
    const headers: Record<string, string> = {
      ...signEsignServiceRequest({ method, url, secret, nowSec: Math.floor(Date.now() / 1000) }),
      'x-request-id': requestId,
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new AramoError('INTERNAL_ERROR', `the document template service could not be reached: ${e instanceof Error ? e.message : String(e)}`, 502, { requestId });
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.ok) return parsed as T;
    // A refusal of sign-service ITSELF (signature / service auth) is a server fault, never
    // the sender's session: it must not read as 401/403 to the browser.
    if (res.status === 401 || res.status === 403) {
      throw new AramoError('INTERNAL_ERROR', `the document template service refused sign-service (HTTP ${res.status})`, 502, { requestId });
    }
    const err = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    if (err !== undefined && typeof err.code === 'string' && typeof err.message === 'string') {
      throw new AramoError(err.code as ErrorCode, err.message, res.status, {
        requestId,
        ...(err.details !== null && typeof err.details === 'object' ? { details: err.details as Record<string, unknown> } : {}),
      });
    }
    throw new AramoError('INTERNAL_ERROR', `the document template service answered HTTP ${res.status}`, 502, { requestId });
  }
}
