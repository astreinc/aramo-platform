import { createHmac, timingSafeEqual } from 'node:crypto';

// DocuSign Connect (webhooks) — HMAC-SHA256 over the RAW request body, base64,
// one header per configured key (X-DocuSign-Signature-1..N); any one match is
// enough. Compared in constant time. The payload is then only a hint: completion
// is confirmed by reading the envelope from the DocuSign API.

export const DOCUSIGN_EVIDENCE_KIND = 'DOCUSIGN_CERTIFICATE_OF_COMPLETION';
export const DOCUSIGN_WEBHOOK_ROUTE = '/v1/webhooks/esignature/docusign';
export const DOCUSIGN_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export function verifyDocuSignHmac(raw: Buffer, headers: Record<string, string | string[] | undefined>, key: string): boolean {
  const expected = createHmac('sha256', key.replace(/"/g, '')).update(raw).digest();
  for (let i = 1; i <= 10; i += 1) {
    const value = headers[`x-docusign-signature-${i}`];
    if (typeof value !== 'string' || value.length === 0) continue;
    let given: Buffer;
    try {
      given = Buffer.from(value, 'base64');
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export interface DocuSignEvent {
  readonly event: string;
  readonly account_id: string;
  readonly envelope_id: string;
}

/** Accepts the wrapped JSON (SIM) shape ({ event, data: { accountId, envelopeId } }) and the flat shape. */
export function parseDocuSignEvent(raw: Buffer): DocuSignEvent | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const data = (typeof body['data'] === 'object' && body['data'] !== null ? body['data'] : body) as Record<string, unknown>;
  const event = body['event'];
  const account_id = data['accountId'];
  const envelope_id = data['envelopeId'];
  if (typeof event !== 'string' || typeof account_id !== 'string' || typeof envelope_id !== 'string') return null;
  return { event, account_id, envelope_id };
}
