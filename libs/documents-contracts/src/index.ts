// @aramo/documents-contracts — provider-neutral cross-service contracts for the
// Documents/E-Sign seam (DOC-3). No domain logic, no persistence — types + tokens.
export {
  SIGNATURE_PROVIDER_PORT,
  type SignatureProviderPort,
  type CreateEnvelopeRequest,
  type ProviderDocumentInput,
  type ProviderSignerInput,
  type ProviderFieldInput,
  type ProviderSignerSummary,
  type EnvelopeSummary,
  type EvidenceSummary,
  type SignatureActor,
  signatureActor,
} from './lib/signature-provider.port.js';
export {
  ESIGN_S2S_SCHEME,
  ESIGN_S2S_TIMESTAMP_HEADER,
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_TOLERANCE_SEC,
  type EsignS2sVerifyReason,
  type EsignS2sVerifyResult,
  normalizeEsignS2sQuery,
  canonicalEsignS2sRequest,
  computeEsignS2sSignature,
  signEsignServiceRequest,
  verifyEsignServiceRequest,
} from './lib/esign-service-request-auth.js';
