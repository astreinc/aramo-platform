// DOC-3 §229 — the PROVIDER-NEUTRAL cross-service contract Documents invokes to
// drive signature execution. apps/api (Documents composition) depends ONLY on
// this port; the concrete transport is an HTTP adapter to apps/sign-service.
// Future DocuSign/AdobeSign/Tenant providers implement the SAME caller-facing
// contract without changing RTR/Offer orchestration (R29 deferred). This is a
// TRANSPORT contract — no RTR/Submittal/Offer/Placement/recruiter-workflow shape.

export const SIGNATURE_PROVIDER_PORT = 'SIGNATURE_PROVIDER_PORT';

export interface ProviderDocumentInput {
  document_ref: string; // documents.Document id (opaque)
  document_revision_ref: string; // frozen documents.DocumentRevision id
  title: string;
  source_sha256: string;
  ordinal: number;
}

export interface ProviderSignerInput {
  email: string;
  name: string;
  signing_order: number;
  signer_role?: string;
}

// PX-V1 F2 — a positioned signature/date/text field on a document. References the
// document by its ordinal and (optionally) the signer by signing_order, since
// server-assigned ids are not known to the caller at create time. ADDITIVE +
// OPTIONAL on CreateEnvelopeRequest: existing ATS callers (RTR/Offer) that supply
// no fields remain valid and unchanged.
export interface ProviderFieldInput {
  document_ordinal: number; // references ProviderDocumentInput.ordinal
  signer_signing_order?: number; // references ProviderSignerInput.signing_order
  field_type: string; // SIGNATURE|INITIALS|SIGN_DATE|SIGNER_NAME|TEXT|CHECKBOX|ACKNOWLEDGEMENT
  page_number: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  required?: boolean;
}

export interface CreateEnvelopeRequest {
  tenant_id: string;
  subject: string;
  execution_mode: string; // ACKNOWLEDGEMENT|SINGLE_SIGNATURE|MULTI_SIGNATURE
  created_by: string;
  documents: ProviderDocumentInput[];
  signers: ProviderSignerInput[];
  fields?: ProviderFieldInput[];
  idempotency_key?: string;
}

export interface ProviderSignerSummary {
  signer_id: string;
  email: string;
  status: string;
}

export interface EnvelopeSummary {
  envelope_id: string;
  status: string;
  signers: ProviderSignerSummary[];
}

export interface EvidenceSummary {
  envelope_id: string;
  status: string;
  event_chain_hash: string | null;
  signature: string | null;
  signature_algorithm: string | null;
  completed_at: string | null;
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.18 — RFC 3161 trusted
  // timestamps (Aramo Sign only). Present only when at least one was recorded.
  trusted_timestamps?: TrustedTimestampEvidence[];
}

// One RFC 3161 timestamp: an executed document's SHA-256 or the completed evidence
// manifest's. PENDING = requested, not yet granted (retried in the background).
export interface TrustedTimestampEvidence {
  subject_kind: 'EXECUTED_DOCUMENT' | 'EVIDENCE_MANIFEST';
  envelope_document_id: string | null;
  message_imprint_sha256: string;
  hash_algorithm: string;
  status: 'PENDING' | 'GRANTED';
  gen_time: string | null;
  tsa_name: string | null;
  tsa_url: string;
  serial_number: string | null;
  policy_oid: string | null;
  tsa_certificate_sha256: string | null;
  // The DER TimeStampToken, base64.
  token_der_base64: string | null;
  // EVIDENCE_MANIFEST only: the exact manifest JSON that was time-stamped.
  subject_canonical: string | null;
}

// Sign Unified Product — Addendum S6 ruling 2: the OPTIONAL typed actor credential
// a user-initiated call carries, so the native Aramo Sign adapter can act through
// the Sign API on the user's verified behalf (USER-mode token exchange). It is
// provider-specific: callers pass it ONLY to the Aramo Sign adapter, never to an
// external provider. The bearer value is non-enumerable and redacted from JSON
// and inspection, so it cannot reach a log or a serialized payload by accident.
export interface SignatureActor {
  readonly kind: 'aramo-user';
  readonly access_token: string;
}

export function signatureActor(access_token: string): SignatureActor {
  const actor = { kind: 'aramo-user' as const };
  Object.defineProperty(actor, 'access_token', { value: access_token, enumerable: false, writable: false });
  Object.defineProperty(actor, 'toJSON', { value: () => ({ kind: 'aramo-user', access_token: '[redacted]' }), enumerable: false });
  Object.defineProperty(actor, Symbol.for('nodejs.util.inspect.custom'), { value: () => "SignatureActor { kind: 'aramo-user', access_token: [redacted] }", enumerable: false });
  return actor as SignatureActor;
}

// The caller-facing signature-provider contract. Idempotent per Invariant 16.
// `actor` (optional, last) is honoured only by the Aramo Sign adapter (S6).
export interface SignatureProviderPort {
  createEnvelope(req: CreateEnvelopeRequest, actor?: SignatureActor): Promise<EnvelopeSummary>;
  sendEnvelope(tenant_id: string, envelope_id: string, idempotency_key?: string, actor?: SignatureActor): Promise<EnvelopeSummary>;
  getEnvelope(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EnvelopeSummary>;
  voidEnvelope(tenant_id: string, envelope_id: string, reason: string, actor?: SignatureActor): Promise<EnvelopeSummary>;
  getEvidence(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EvidenceSummary>;
  // COMM-RECRUITER-W1 (W1-C1) — reverse-resolve the single NON-TERMINAL envelope
  // for a document revision (E-Sign owns envelope identity; Documents never store
  // envelope_id). null = none; throws ESIGN_ENVELOPE_AMBIGUOUS when >1 exist.
  findEnvelopeForDocument(
    tenant_id: string,
    document_ref: string,
    document_revision_ref: string,
    actor?: SignatureActor,
  ): Promise<EnvelopeSummary | null>;
  // COMM-RECRUITER-W1 (W1-C2) — same-envelope reminder for an already-sent
  // envelope. Revokes prior non-terminal signer session(s), mints a new one,
  // records a reminder event + notification. NOT sendEnvelope (no DRAFT→SENT).
  remindEnvelopeSigner(tenant_id: string, envelope_id: string, actor?: SignatureActor): Promise<EnvelopeSummary>;
}
