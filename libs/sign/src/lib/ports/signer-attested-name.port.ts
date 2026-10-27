// M-A6 §2.2 — the name a HOSTED (in-person) signer attested when accepting the
// disclosure (M-A5 §3.4). A SIGNER_PROFILE name field is filled with it, instead
// of Signer.name, when the signing session is HOSTED.
//
// Integration point: the hosted-signing slice (M-A5) owns where the attested name
// is stored. It binds this port in the sign-service composition root and answers
// with the attested name for a HOSTED session, or null for any other session.
// While the port is unbound, EsignService fills SIGNER_PROFILE names from
// Signer.name — the documented fallback, covered by a test.

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
