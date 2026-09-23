// DOC-4 (R-4-8) — the E-Sign public signer transport client. Talks ONLY to
// /v1/esign/signing/* (proxied to esign-service). The tenant is resolved
// server-side FROM the capability token; the client never sends a tenant id.

export interface SignerSession {
  session_id: string;
  envelope_id: string;
  signer_id: string;
}

export interface SignField {
  field_id: string;
  field_type: string;
  page_number: number;
  required: boolean;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/v1/esign/signing/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(detail.message ?? `request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

export const signApi = {
  exchange(token: string): Promise<SignerSession> {
    return post<SignerSession>('exchange', { token });
  },
  acceptDisclosure(token: string, disclosure_version: string, disclosure_text_hash: string): Promise<void> {
    return post<void>('disclosure', { token, disclosure_version, disclosure_text_hash });
  },
  fillField(token: string, fieldId: string, value: string, signature_method: string): Promise<void> {
    return post<void>(`fields/${fieldId}/fill`, { token, value, signature_method });
  },
  complete(token: string): Promise<{ envelope_status: string }> {
    return post<{ envelope_status: string }>('complete', { token });
  },
};
