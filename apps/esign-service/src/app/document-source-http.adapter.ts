import { Injectable } from '@nestjs/common';
import { signEsignServiceRequest } from '@aramo/documents-contracts';
import { type DocumentSourceProviderPort, type DocumentSourceRequest } from '@aramo/esign';

// DOC-4 (R-4-3) — the authorized source-PDF read (esign-service -> apps/api).
// E-Sign holds no DocumentStoragePort and never touches the documents schema; it
// fetches the frozen revision bytes for executed-document production and the
// signer document view over HTTP. Base URL: DOCUMENTS_API_URL (on the box the
// compose-internal origin http://api:3000).
//
// ES-2 (Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0):
// every request is signed with the shared aramo-esign-s2s-v1 scheme (method + exact
// path + query + timestamp) keyed by ESIGN_WEBHOOK_SIGNING_SECRET. Fail closed:
// without the secret no request is sent.

@Injectable()
export class DocumentSourceHttpAdapter implements DocumentSourceProviderPort {
  private baseUrl(): string {
    return process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
  }

  async getSourcePdf(input: DocumentSourceRequest): Promise<Uint8Array> {
    // CORE_REF only — the OWNED path is served by the object-storage resolver.
    if (typeof input.document_revision_ref !== 'string' || input.document_revision_ref.length === 0) {
      throw new Error('CORE_REF source fetch requires a document_revision_ref');
    }
    const secret = process.env['ESIGN_WEBHOOK_SIGNING_SECRET'];
    if (secret === undefined || secret.length === 0) {
      throw new Error('source fetch not attempted: ESIGN_WEBHOOK_SIGNING_SECRET is not configured (esign-service requests must be signed)');
    }
    const url = `${this.baseUrl()}/v1/documents/revisions/${encodeURIComponent(input.document_revision_ref)}/source?tenant_id=${encodeURIComponent(input.tenant_id)}`;
    const headers = signEsignServiceRequest({ method: 'GET', url, secret, nowSec: Math.floor(Date.now() / 1000) });
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`source fetch failed for revision ${input.document_revision_ref}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { source_base64?: string };
    if (typeof body.source_base64 !== 'string') {
      throw new Error(`source fetch returned no source_base64 for revision ${input.document_revision_ref}`);
    }
    return new Uint8Array(Buffer.from(body.source_base64, 'base64'));
  }
}
