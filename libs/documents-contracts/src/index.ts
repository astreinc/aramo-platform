// @aramo/documents-contracts — provider-neutral cross-service contracts for the
// Documents/E-Sign seam (DOC-3). No domain logic, no persistence — types + tokens.
export {
  SIGNATURE_PROVIDER_PORT,
  type SignatureProviderPort,
  type CreateEnvelopeRequest,
  type ProviderDocumentInput,
  type ProviderSignerInput,
  type ProviderSignerSummary,
  type EnvelopeSummary,
  type EvidenceSummary,
} from './lib/signature-provider.port.js';
