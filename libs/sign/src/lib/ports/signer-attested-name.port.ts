// M-A6 §2.2 — the name a HOSTED (in-person) signer attested when accepting the
// disclosure (M-A5 §3.4). A SIGNER_PROFILE name field is filled with it, instead
// of Signer.name, when the signing session is HOSTED.
//
// Binding: EsignModule binds PrismaSignerAttestedNameAdapter by default, which
// reads SignerDisclosureAcceptance.attested_name (stored by M-A5 §3.4) for a
// HOSTED session and answers null for any other session. When the port is
// unbound (direct construction in domain tests), EsignService fills
// SIGNER_PROFILE names from Signer.name — the documented fallback.

export const SIGNER_ATTESTED_NAME_PORT = 'SIGNER_ATTESTED_NAME_PORT';

export interface SignerAttestedNameQuery {
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  session_id: string;
}

export interface SignerAttestedNamePort {
  // The attested name for this HOSTED session; null when the session is not
  // HOSTED or no name was attested.
  attestedName(query: SignerAttestedNameQuery): Promise<string | null>;
}
