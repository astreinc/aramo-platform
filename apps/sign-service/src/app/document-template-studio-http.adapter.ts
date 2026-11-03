import { Injectable } from '@nestjs/common';
import { AramoError, type ErrorCode } from '@aramo/common';
import { SIGN_TEMPLATE_BODY_DIGEST_PARAM, SIGN_TEMPLATE_LIBRARY_PATH, signEsignServiceRequest, signTemplateBodyDigest } from '@aramo/documents-contracts';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Documents
// template Studio + "Use as it is" calls of Aramo Sign, over the SAME signed service-to-service
// channel as DocumentTemplatesHttpAdapter (aramo-sign-s2s-v1, SIGN_WEBHOOK_SIGNING_SECRET). Sign
// never reads or writes the documents schema: every row is written by apps/api. tenant_id and the
// acting person (actor_id) are signed query parameters; a body is bound by the signed
// `body_sha256`. Fail closed: without the secret no request is sent.
//
// A typed refusal from apps/api is passed through with its status. A 401/403 is a refusal of
// sign-service ITSELF (signature) and becomes a 502 — EXCEPT the Studio's own person-level
// refusals (details.reason below), which are the user's answer and pass through as 403.

export const DOCUMENT_TEMPLATE_STUDIO_PORT = 'DOCUMENT_TEMPLATE_STUDIO_PORT';

export const TEMPLATE_GALLERY_PATH = `${SIGN_TEMPLATE_LIBRARY_PATH}/library`;
export const TEMPLATE_STUDIO_PATH = `${SIGN_TEMPLATE_LIBRARY_PATH}/studio`;

/** The person-level refusals apps/api answers 403 with (SignTemplateStudioService). */
export const PASS_THROUGH_REFUSALS: ReadonlySet<string> = new Set([
  'organization_templates_in_org_home',
  'template_authoring_required',
  'template_approval_required',
]);

export type StudioMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface DocumentTemplateStudioPort {
  /**
   * One signed call. `path` is relative to the Documents template family
   * (e.g. `/library`, `/studio/{id}/versions`); `query` carries tenant_id (+ actor_id).
   */
  call<T>(input: { method: StudioMethod; path: string; query: Record<string, string>; body?: unknown; requestId: string }): Promise<T>;
}

@Injectable()
export class DocumentTemplateStudioHttpAdapter implements DocumentTemplateStudioPort {
  private baseUrl(): string {
    return process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
  }

  async call<T>(input: { method: StudioMethod; path: string; query: Record<string, string>; body?: unknown; requestId: string }): Promise<T> {
    const { requestId } = input;
    const secret = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    if (secret === undefined || secret.length === 0) {
      throw new AramoError('ESIGN_SERVICE_AUTH_UNAVAILABLE', 'templates are unavailable: sign-service requests to Documents are not configured', 503, { requestId });
    }
    const hasBody = input.method === 'POST' || input.method === 'PATCH';
    const body = hasBody ? (input.body ?? {}) : undefined;
    const q = new URLSearchParams({ ...input.query, ...(body !== undefined ? { [SIGN_TEMPLATE_BODY_DIGEST_PARAM]: signTemplateBodyDigest(body) } : {}) });
    const url = `${this.baseUrl()}${SIGN_TEMPLATE_LIBRARY_PATH}${input.path}?${q.toString()}`;
    const headers: Record<string, string> = {
      ...signEsignServiceRequest({ method: input.method, url, secret, nowSec: Math.floor(Date.now() / 1000) }),
      'x-request-id': requestId,
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method: input.method,
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
    if (res.ok) return (res.status === 204 ? undefined : parsed) as T;
    const err = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const details = err?.details !== null && typeof err?.details === 'object' ? (err.details as Record<string, unknown>) : undefined;
    if (res.status === 401 || (res.status === 403 && !PASS_THROUGH_REFUSALS.has(String(details?.['reason'] ?? '')))) {
      throw new AramoError('INTERNAL_ERROR', `the document template service refused sign-service (HTTP ${res.status})`, 502, { requestId });
    }
    if (err !== undefined && typeof err.code === 'string' && typeof err.message === 'string') {
      throw new AramoError(err.code as ErrorCode, err.message, res.status, { requestId, ...(details !== undefined ? { details } : {}) });
    }
    throw new AramoError('INTERNAL_ERROR', `the document template service answered HTTP ${res.status}`, 502, { requestId });
  }
}
