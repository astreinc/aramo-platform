// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.16 (QES) under Amendment A1
// (vendor-dependent features built in parallel): the VENDOR-NEUTRAL port for qualified
// electronic signatures through a Qualified Trust Service Provider (QTSP) remote-signing
// service.
//
// Aramo is NOT a QTSP and never issues, holds or controls a qualified certificate or
// signing key (§4 R-1). The QTSP performs identity proofing of the signer, holds the
// signer's key in its remote QSCD, and authorizes each signature with the signer. Aramo
// only (1) sends the signer to the QTSP, (2) learns which credential the QTSP issued,
// (3) asks the QTSP to sign one hash the signer authorized, and (4) keeps the returned
// signature and certificate chain as evidence. Nothing here is marketed or sold (R-2).
//
// The shape follows the Cloud Signature Consortium (CSC) API v2 remote-signing flow,
// which most QTSPs implement:
//   phase 1 — OAuth 2.0 authorization with scope "service": the QTSP authenticates and
//             proofs the signer; Aramo then reads the signer's credential
//             (credentials/list + credentials/info, certificate chain).
//   phase 2 — OAuth 2.0 authorization with scope "credential" for exactly the hash to
//             sign (the signer's explicit consent at the QTSP), then signatures/signHash.
// No access token is ever persisted: each authorization code is exchanged and used in
// the same request.
//
// Adapters (composition root, apps/sign-service): `disabled` (the default — no QTSP is
// contracted, Amendment A1 §A1.1) and a generic CSC v2 adapter that needs only
// configuration and stays off while its environment is unset. Unit tests use stubs and
// never call a live QTSP.

export const QES_SIGNING_PORT = 'QES_SIGNING_PORT';

/** OID of SHA-256 (the digest Aramo computes over the documents to sign). */
export const QES_HASH_ALGORITHM_SHA256_OID = '2.16.840.1.101.3.4.2.1';

/** The signer as the sender entered them (a hint only: the QTSP proofs identity itself). */
export interface QesSignerHint {
  name: string;
  email: string | null;
}

export interface QesBeginIdentityInput {
  /** Opaque correlation value echoed back by the QTSP (OAuth `state`). */
  state: string;
  redirect_uri: string;
  signer: QesSignerHint;
}

export interface QesCompleteIdentityInput {
  authorization_code: string;
  redirect_uri: string;
}

/** What the QTSP reports about the signer's qualified credential after identity proofing. */
export interface QesCredential {
  /** The QTSP's credential identifier (CSC credentialID). Not a secret. */
  credential_id: string;
  /** PEM certificates, signer certificate first, then the issuing chain. */
  certificate_chain_pem: string[];
  /** Signature algorithm OIDs the credential supports (CSC key.algo). */
  signature_algorithm_oids: string[];
  /** Assurance the QTSP reports for the credential (e.g. CSC SCAL "2"); null when absent. */
  authorization_level: string | null;
}

export interface QesBeginSignatureInput {
  state: string;
  redirect_uri: string;
  credential_id: string;
  /** base64 of the digest to sign. */
  hash_b64: string;
  hash_algorithm_oid: string;
}

export interface QesSignHashInput {
  authorization_code: string;
  redirect_uri: string;
  credential_id: string;
  hash_b64: string;
  hash_algorithm_oid: string;
  signature_algorithm_oid: string;
}

export interface QesSignatureResult {
  /** base64 of the raw signature value returned by the QTSP. */
  signature_b64: string;
  /** The QTSP's transaction or audit reference, when it returns one. */
  qtsp_reference: string | null;
}

export interface QesSigningPort {
  /** Stable adapter key recorded in evidence (e.g. "disabled", "csc"). */
  readonly provider: string;
  /** false ⇒ no QTSP is configured; every method refuses. */
  readonly configured: boolean;
  /** Phase 1 start: where to send the signer for identity proofing and service authorization. */
  beginIdentity(input: QesBeginIdentityInput): Promise<{ redirect_url: string }>;
  /** Phase 1 end: exchange the code and read the signer's qualified credential. */
  completeIdentity(input: QesCompleteIdentityInput): Promise<QesCredential>;
  /** Phase 2 start: where to send the signer to authorize signing exactly this hash. */
  beginSignature(input: QesBeginSignatureInput): Promise<{ redirect_url: string }>;
  /** Phase 2 end: exchange the code and have the QTSP sign the authorized hash. */
  signHash(input: QesSignHashInput): Promise<QesSignatureResult>;
}

/** Raised when QES is requested but no QTSP adapter is configured. */
export class QesProviderNotConfiguredError extends Error {
  constructor() {
    super('No qualified trust service provider is configured');
    this.name = 'QesProviderNotConfiguredError';
  }
}

/** A QTSP refused or failed a step. `reason` is a short, non-sensitive code. */
export class QesProviderError extends Error {
  constructor(
    public readonly reason: string,
    message = `The qualified trust service provider refused the request (${reason})`,
  ) {
    super(message);
    this.name = 'QesProviderError';
  }
}

/** The production default: no QTSP is contracted (Amendment A1 §A1.1). */
export class DisabledQesSigningAdapter implements QesSigningPort {
  readonly provider = 'disabled';
  readonly configured = false;
  async beginIdentity(): Promise<{ redirect_url: string }> {
    throw new QesProviderNotConfiguredError();
  }
  async completeIdentity(): Promise<QesCredential> {
    throw new QesProviderNotConfiguredError();
  }
  async beginSignature(): Promise<{ redirect_url: string }> {
    throw new QesProviderNotConfiguredError();
  }
  async signHash(): Promise<QesSignatureResult> {
    throw new QesProviderNotConfiguredError();
  }
}
