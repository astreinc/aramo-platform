import { Injectable } from '@nestjs/common';
import { type DocumentSourceProviderPort, type DocumentSourceRequest } from '@aramo/esign';

// DOC-4 (R-4-3) — the authorized source-PDF read (esign-service -> apps/api).
// E-Sign holds no DocumentStoragePort and never touches the documents schema; it
// fetches the frozen revision bytes for executed-document production over HTTP.
// Base URL: DOCUMENTS_API_URL (default the apps/api origin). Service-to-service.

@Injectable()
export class DocumentSourceHttpAdapter implements DocumentSourceProviderPort {
  private baseUrl(): string {
    return process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
  }

  async getSourcePdf(input: DocumentSourceRequest): Promise<Uint8Array> {
    const url = `${this.baseUrl()}/v1/documents/revisions/${input.document_revision_ref}/source?tenant_id=${encodeURIComponent(input.tenant_id)}`;
    const res = await fetch(url, { headers: { 'X-Esign-Service': '1' } });
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
