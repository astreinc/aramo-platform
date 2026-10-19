// DOC-4 (R-4-8) — the E-Sign public signer transport client. Talks ONLY to
// /v1/esign/signing/* (proxied to esign-service). The tenant is resolved
// server-side FROM the capability token; the client never sends a tenant id.
// Unified UX (signer handoff §6–§7): typed errors so each token state gets its
// own screen, plus the existing document / source / decline endpoints.

export interface SignerSession {
  session_id: string;
  envelope_id: string;
  signer_id: string;
}

export type SignFieldType =
  | 'SIGNATURE'
  | 'INITIALS'
  | 'SIGN_DATE'
  | 'SIGNER_NAME'
  | 'TEXT'
  | 'CHECKBOX'
  | 'ACKNOWLEDGEMENT';

export interface SignField {
  field_id: string;
  document_id: string;
  field_type: SignFieldType | string;
  page_number: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  required: boolean;
  // PX-2 — true once this signer has filled the field (restores progress on reload).
  filled?: boolean;
  // PX-2 — the signer's own entered value, returned to restore the page.
  value?: string | null;
}

export interface SignDocumentMeta {
  document_id: string;
  title: string;
  ordinal: number;
}

export interface SignerDocumentView {
  documents: SignDocumentMeta[];
  fields: SignField[];
}

/** A failed signer call. `code` is the server's error code, or NETWORK. */
export class SignApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'SignApiError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    // Sign Unified Product S-2 — guest signing shares the host with the signed-in
    // workspace; the capability token in the body is the ONLY authority, so the
    // request never carries workspace cookies (credentials: 'omit').
    res = await fetch(`/v1/esign/signing/${path}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignApiError('NETWORK', 0);
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    throw new SignApiError(detail.error?.code ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

// Aramo Sign launch (A-7) — the disclosure is SERVER-HELD and versioned: the app
// shows the text E-Sign returns and sends that exact version + hash back on
// acceptance, so the record names precisely what the signer agreed to.
export interface SignerDisclosure {
  disclosure_version: string;
  text: string;
  text_sha256: string;
}

// Aramo Sign launch — the signer's signed copy (from the completion email link).
export interface ExecutedCopy {
  subject: string;
  completed_at: string | null;
  documents: { title: string; content_type: string; executed_base64: string }[];
  certificate_base64: string | null;
}

export const signApi = {
  exchange(token: string): Promise<SignerSession> {
    return post<SignerSession>('exchange', { token });
  },
  disclosureText(token: string): Promise<SignerDisclosure> {
    return post<SignerDisclosure>('disclosure-text', { token });
  },
  acceptDisclosure(token: string, disclosure: SignerDisclosure): Promise<void> {
    return post<void>('disclosure', { token, disclosure_version: disclosure.disclosure_version, disclosure_text_hash: disclosure.text_sha256 });
  },
  executed(token: string): Promise<ExecutedCopy> {
    return post<ExecutedCopy>('executed', { token });
  },
  documentView(token: string): Promise<SignerDocumentView> {
    return post<SignerDocumentView>('document', { token });
  },
  source(token: string, document_id: string): Promise<{ source_base64: string; content_type: string }> {
    return post<{ source_base64: string; content_type: string }>('source', { token, document_id });
  },
  fillField(token: string, fieldId: string, value: string, signature_method?: string): Promise<void> {
    return post<void>(`fields/${encodeURIComponent(fieldId)}/fill`, {
      token,
      value,
      ...(signature_method !== undefined ? { signature_method } : {}),
    });
  },
  complete(token: string): Promise<{ envelope_status: string }> {
    return post<{ envelope_status: string }>('complete', { token });
  },
  decline(token: string, reason: string): Promise<void> {
    return post<void>('decline', { token, reason });
  },
};
