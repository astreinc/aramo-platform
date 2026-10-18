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
    res = await fetch(`/v1/esign/signing/${path}`, {
      method: 'POST',
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

// The frozen disclosure the signer acknowledges (version + text hash recorded
// with the acceptance). The text shown is unchanged from DOC-4; the final
// legal disclosure text is a Legal deliverable.
export const DISCLOSURE_VERSION = 'v1';
export const DISCLOSURE_TEXT_HASH = 'doc4-esign-disclosure-v1';

export const signApi = {
  exchange(token: string): Promise<SignerSession> {
    return post<SignerSession>('exchange', { token });
  },
  acceptDisclosure(token: string): Promise<void> {
    return post<void>('disclosure', { token, disclosure_version: DISCLOSURE_VERSION, disclosure_text_hash: DISCLOSURE_TEXT_HASH });
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
