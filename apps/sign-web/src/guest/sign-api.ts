// DOC-4 (R-4-8) — the E-Sign public signer transport client. Talks ONLY to
// /v1/sign/signing/* (proxied to sign-service). The tenant is resolved
// server-side FROM the capability token; the client never sends a tenant id.
// Unified UX (signer handoff §6–§7): typed errors so each token state gets its
// own screen, plus the existing document / source / decline endpoints.

import { localTimeZone, type AnyFieldType, type FieldOptions, type ProfilePrefill } from '@aramo/sign-client';

import type { TextLayer } from './find.js';

export interface SignerSession {
  session_id: string;
  envelope_id: string;
  signer_id: string;
  // UAT SND-11 (A2-A3) — the caller's own "Sign a document" (absent: an older server).
  self_signing?: boolean;
}

// FIELD-PARITY-1 P1-2 — every type an envelope stores (the catalog's `sign_store` projection):
// the engine types, PAYMENT (Sign 1.14 — paid on Stripe's hosted page; filled by the server once
// paid) and the M-A12 W1-C.4 profile text fields the signer fills.
export type SignFieldType = AnyFieldType;

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
  // FIELD-PARITY-1 P3 §6.2 — the settings the signer page applies (absent: an older server).
  // label (above) is the field's caption and accessible name; tooltip its help text;
  // placeholder the input hint; read_only / sender_filled: the sender's value, shown and never
  // sent; validation + options: the value rules (@aramo/sign-client signerValueProblem).
  tooltip?: string | null;
  placeholder?: string | null;
  read_only?: boolean;
  sender_filled?: boolean;
  validation?: string | null;
  font_size?: number | null;
  data_name?: string | null;
  options?: FieldOptions | null;
  // FIELD-PARITY-2 B-5 — the field's key and "show only when" (null = always shown); apply
  // @aramo/sign-client shownFields to this signer's fields (B-6).
  field_key?: string | null;
  condition?: { readonly trigger_key: string; readonly when: string; readonly values?: readonly string[] } | null;
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
  // Consolidated Directive B3 — the sender allowed delegation and this signer may hand it off.
  can_delegate?: boolean;
  // M-A12 W1-E.2 — the sender's date format for SIGN_DATE (null: an envelope sent before
  // formats were stamped, which keeps YYYY-MM-DD).
  date_format?: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | null;
  // M-A15 §4.1 — the signer's own saved signature / initials, decided by the server from
  // this signing session (null: nothing to offer; absent: an older server).
  saved_marks?: GuestSavedMarks | null;
  // M-A16 §3 — offer "Save to my Aramo inbox" after signing (emailed-link sessions only).
  inbox_save_available?: boolean;
  // Field-test batch 1 SIG-11 (+A1) — the signer's own profile values, decided by the server: a
  // signed-in (inbox / Sign now) session only (null: an emailed link, a hosted session or a
  // guest; absent: an older server). EMAIL is pre-filled on open; the rest are offers only.
  profile_prefill?: ProfilePrefill | null;
}

// M-A15 §4.1 — a saved mark offered on this signing page.
export interface GuestSavedMark {
  kind: 'TYPED' | 'DRAWN';
  typed_name: string | null;
  image_data_url: string;
}
export interface GuestSavedMarks {
  signature: GuestSavedMark | null;
  initials: GuestSavedMark | null;
  // True only when this signing session belongs to a signed-in user (inbox / Sign now).
  can_save: boolean;
}
export type GuestSavedMarkSlot = 'signature' | 'initials';
// The font key the app sends with a typed mark (M-A3 §4).
export const SAVED_MARK_FONT_KEY = 'system-script';

// Feature-Parity §1.16 — the signer's qualified-signature step (null = not required).
export interface QesStatus {
  signature_level: 'QES';
  state: 'REQUIRED' | 'IDENTITY_PROOFING_PENDING' | 'AUTHORIZED' | 'SIGNED' | 'FAILED';
  provider: string | null;
  failure_reason: string | null;
}
export interface QesStep {
  state: QesStatus['state'];
  redirect_url: string | null;
}

// Feature-Parity §1.9 — the SMS code the sender may require before the document opens.
export interface SmsCodeStatus {
  required: boolean;
  verified: boolean;
  locked: boolean;
  phone: string | null;
}

/** A failed signer call. `code` is the server's error code, or NETWORK. */
export class SignApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    // The server's stable details.reason, when it gave one.
    readonly reason?: string,
    // UAT SEC-04 — details.attempts_remaining (a wrong access code), when the server gave it.
    readonly attemptsRemaining?: number,
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
    const detail = (await res.json().catch(() => ({}))) as { error?: { code?: string; details?: { reason?: unknown; attempts_remaining?: unknown } } };
    const reason = detail.error?.details?.reason;
    const left = detail.error?.details?.attempts_remaining;
    throw new SignApiError(
      detail.error?.code ?? `HTTP_${res.status}`,
      res.status,
      typeof reason === 'string' ? reason : undefined,
      typeof left === 'number' && Number.isInteger(left) && left >= 0 ? left : undefined,
    );
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
// M-A5 §2.2 — what a copy recipient sees: the documents as sent (no signer data).
export interface RecipientCopy {
  subject: string;
  sent_at: string | null;
  documents: { title: string; content_type: string; source_base64: string }[];
}

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
  // M-A5 §2.2 / UAT CMP-14 — a copy recipient's documents (as sent), by the COPY_VIEW token.
  copy(token: string): Promise<RecipientCopy> {
    return post<RecipientCopy>('copy', { token });
  },
  documentView(token: string): Promise<SignerDocumentView> {
    return post<SignerDocumentView>('document', { token });
  },
  // M-A15 §4.2 — "Save as my default" (a signed-in signing session only; token-scoped).
  saveMark(
    token: string,
    slot: GuestSavedMarkSlot,
    mark: { kind: 'TYPED'; typed_name: string; font_key: string; image_data_url: string } | { kind: 'DRAWN'; image_data_url: string },
  ): Promise<GuestSavedMark> {
    return post<GuestSavedMark>('saved-mark', { token, slot, ...mark });
  },
  // UAT SIG-16 retest — the document's words with boxes for Find (the app's route, M-A12 W1-C.2).
  textLayer(token: string, document_id: string): Promise<TextLayer> {
    return post<TextLayer>(`documents/${encodeURIComponent(document_id)}/text-layer`, { token });
  },
  source(token: string, document_id: string): Promise<{ source_base64: string; content_type: string }> {
    return post<{ source_base64: string; content_type: string }>('source', { token, document_id });
  },
  // Client Rule Consolidation C0-2 — every fill and the completion carry the signer's IANA
  // time zone: the server stamps SIGN_DATE in it (the value this page shows is a preview).
  // FIELD-PARITY-2 B-6 follow-up — value null clears a stored value (where the shared rule
  // @aramo/sign-client signerClearRefusal allows it): the field editor's "Clear answer".
  fillField(token: string, fieldId: string, value: string | null, signature_method?: string): Promise<void> {
    const time_zone = localTimeZone();
    return post<void>(`fields/${encodeURIComponent(fieldId)}/fill`, {
      token,
      value,
      ...(signature_method !== undefined ? { signature_method } : {}),
      ...(time_zone !== null ? { time_zone } : {}),
    });
  },
  complete(token: string): Promise<{ envelope_status: string }> {
    const time_zone = localTimeZone();
    return post<{ envelope_status: string }>('complete', { token, ...(time_zone !== null ? { time_zone } : {}) });
  },
  decline(token: string, reason: string): Promise<void> {
    return post<void>('decline', { token, reason });
  },
  // Feature-Parity §1.9 — the access code the sender set for this recipient (never stored here).
  accessCode(token: string, access_code: string): Promise<{ verified: true }> {
    return post<{ verified: true }>('access-code', { token, access_code });
  },
  // B3 / Feature-Parity §1.17 — hand this signature to another person; this link then stops working.
  delegate(token: string, input: { name: string; email: string; reason?: string }): Promise<{ delegated: true }> {
    return post<{ delegated: true }>('delegate', { token, ...input });
  },
  // B3 / Feature-Parity §1.16 — the qualified signature through the sender's trust service provider.
  qesStatus(token: string): Promise<{ qes: QesStatus | null }> {
    return post<{ qes: QesStatus | null }>('qes/status', { token });
  },
  qesBegin(token: string): Promise<QesStep> {
    return post<QesStep>('qes/begin', { token });
  },
  qesComplete(token: string, code: string, state: string): Promise<QesStep> {
    return post<QesStep>('qes/complete', { token, code, state });
  },
  // Feature-Parity §1.9 — the SMS code (sender-set): status, send, verify.
  smsCodeStatus(token: string): Promise<SmsCodeStatus> {
    return post<SmsCodeStatus>('verification', { token });
  },
  smsCodeSend(token: string): Promise<{ sent: boolean; verified: boolean; phone: string | null }> {
    return post<{ sent: boolean; verified: boolean; phone: string | null }>('verification/sms-otp/send', { token });
  },
  smsCodeVerify(token: string, code: string): Promise<{ verified: true }> {
    return post<{ verified: true }>('verification/sms-otp/verify', { token, code });
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
