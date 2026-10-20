import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  verifyEsignServiceRequest,
} from '@aramo/documents-contracts';

import { DocumentSourceHttpAdapter } from '../app/document-source-http.adapter.js';

// ES-2 — the sign-service side of the aramo-sign-s2s-v1 scheme: every source
// pull is signed, verifies against the SHARED verifier over real HTTP, and no
// request leaves without the secret.

const SECRET = 'adapter-spec-secret';
const REV = 'd0c4c000-0000-7000-8000-000000000001';
const TENANT = '11111111-1111-7111-8111-111111111111';
const BYTES = Buffer.from('%PDF-1.4 adapter round trip');

describe('DocumentSourceHttpAdapter — signed source pull (ES-2)', () => {
  let server: Server;
  const seen: IncomingMessage[] = [];
  const saved = { url: process.env['DOCUMENTS_API_URL'], secret: process.env['SIGN_WEBHOOK_SIGNING_SECRET'] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req);
      const raw = req.url ?? '';
      const q = raw.indexOf('?');
      const verdict = verifyEsignServiceRequest({
        method: req.method ?? '',
        path: q === -1 ? raw : raw.slice(0, q),
        rawQuery: q === -1 ? '' : raw.slice(q + 1),
        timestampHeader: req.headers[ESIGN_S2S_TIMESTAMP_HEADER] as string | undefined,
        signatureHeader: req.headers[ESIGN_S2S_SIGNATURE_HEADER] as string | undefined,
        secret: SECRET,
        nowSec: Math.floor(Date.now() / 1000),
      });
      res.statusCode = verdict.ok ? 200 : 401;
      res.setHeader('content-type', 'application/json');
      res.end(verdict.ok ? JSON.stringify({ revision_id: REV, source_base64: BYTES.toString('base64') }) : '{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env['DOCUMENTS_API_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    seen.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (saved.url === undefined) delete process.env['DOCUMENTS_API_URL'];
    else process.env['DOCUMENTS_API_URL'] = saved.url;
    if (saved.secret === undefined) delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    else process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = saved.secret;
  });

  it('signs the pull so the shared verifier accepts it, and returns the bytes unchanged', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    const out = await new DocumentSourceHttpAdapter().getSourcePdf({ tenant_id: TENANT, source_mode: 'CORE_REF', document_ref: 'd', document_revision_ref: REV, source_object_key: null });
    expect(Buffer.from(out).equals(BYTES)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-sign-service']).toBeUndefined();
  });

  it('a different secret on the Core side is refused (no silent success)', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'not-the-core-secret';
    await expect(
      new DocumentSourceHttpAdapter().getSourcePdf({ tenant_id: TENANT, source_mode: 'CORE_REF', document_ref: 'd', document_revision_ref: REV, source_object_key: null }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('fails closed without the secret: no request is sent', async () => {
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    await expect(
      new DocumentSourceHttpAdapter().getSourcePdf({ tenant_id: TENANT, source_mode: 'CORE_REF', document_ref: 'd', document_revision_ref: REV, source_object_key: null }),
    ).rejects.toThrow(/not configured/);
    expect(seen).toHaveLength(0);
  });
});
