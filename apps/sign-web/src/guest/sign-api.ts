// DOC-4 (R-4-8) — the E-Sign public signer transport client. Talks ONLY to
// /v1/sign/signing/* (proxied to sign-service). The tenant is resolved
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
  | 'ACKNOWLEDGEMENT'
  // Sign 1.14 — paid on Stripe's hosted page; filled by the server once paid.
  | 'PAYMENT';

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
  // PX-2 — the signer's own entered value, returned to restore the page. M-A6 —
  // for a server-filled name, the name the server fills.
  value?: string | null;
  // M-A6 §2 — the field configuration (null where it does not apply).
  label?: string | null;
  group_key?: string | null;
  group_rule?: 'SELECT_ONE' | 'SELECT_ANY' | null;
  min_selected?: number | null;
  name_mode?: 'SIGNER_PROFILE' | 'SIGNER_ENTERED' | null;
  // M-A6 §2.2 — true for a SIGNER_PROFILE name: shown read-only, never filled here.
  // Sign 1.14 — also true for a PAYMENT field (filled when the payment succeeds).
  server_filled?: boolean;
  // Sign 1.14 — the amount to pay (PAYMENT only).
  payment?: { amount_minor: number; currency: string } | null;
}

// Sign 1.14 — starting a payment: Stripe's hosted page, or already paid.
export type PaymentStart = { status: 'CHECKOUT'; checkout_url: string } | { status: 'PAID' };

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
    // The server's stable details.reason, when it gave one.
    readonly reason?: string,
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
    res = await fetch(`/v1/sign/signing/${path}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignApiError('NETWORK', 0);
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: { code?: string; details?: { reason?: unknown } } };
    const reason = detail.error?.details?.reason;
    throw new SignApiError(detail.error?.code ?? `HTTP_${res.status}`, res.status, typeof reason === 'string' ? reason : undefined);
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

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — the sending organization's
// branding for this page, or null for the Aramo Sign look (dark until the feature is offered).
export interface SignerBranding {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  // A same-origin path (/v1/sign/signing/brand-logo/<id>), or null.
  logo_url: string | null;
}

// Feature-Parity §1.9 — the identity check the sender may require before the document opens.
export interface IdentityVerificationStatus {
  method: 'ID_VERIFICATION' | 'KBA' | null;
  state: 'NOT_REQUIRED' | 'REQUIRED' | 'PENDING' | 'VERIFIED' | 'LOCKED';
  attempts_remaining: number | null;
  last_failure: string | null;
  verification_url?: string | null;
}

export const signApi = {
  branding(token: string): Promise<SignerBranding | null> {
    return post<{ branding: SignerBranding | null }>('branding', { token }).then((r) => r.branding ?? null);
  },
  identityStatus(token: string): Promise<IdentityVerificationStatus> {
    return post<IdentityVerificationStatus>('identity-verification/status', { token });
  },
  identityStart(token: string): Promise<IdentityVerificationStatus> {
    return post<IdentityVerificationStatus>('identity-verification/start', { token });
  },
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
  // Feature-Parity §1.9 — the access code the sender set for this recipient (never stored here).
  accessCode(token: string, access_code: string): Promise<{ verified: true }> {
    return post<{ verified: true }>('access-code', { token, access_code });
  },
  // Sign 1.14 — pay a PAYMENT field on Stripe's hosted Checkout page (the organization's
  // own Stripe account), then confirm on return. The server is the only authority.
  startPayment(token: string, field_id: string): Promise<PaymentStart> {
    return post<PaymentStart>('payment/checkout', { token, field_id });
  },
  confirmPayment(token: string, field_id: string): Promise<{ status: string }> {
    return post<{ status: string }>('payment/confirm', { token, field_id });
  },
};
