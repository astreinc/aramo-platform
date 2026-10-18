import type { SignatureProviderPort } from '@aramo/documents-contracts';
import type { SignatureProviderKey } from '@aramo/signature-routing';

// Multi-Provider directive §D/§F — how governed signing picks a provider. A NEW
// request goes to the tenant's selected provider (after the availability check);
// an EXISTING request always goes to the provider frozen on it.

export const SIGNATURE_PROVIDER_REGISTRY = 'SIGNATURE_PROVIDER_REGISTRY';
export type SignatureProviderRegistry = ReadonlyMap<SignatureProviderKey, SignatureProviderPort>;

export interface RoutedSignatureProvider {
  readonly provider: SignatureProviderKey;
  readonly port: SignatureProviderPort;
}

export interface SignatureRouter {
  /** Asserts the tenant can send now; throws ESIGN_SEND_UNAVAILABLE with the reason. */
  forNewSend(tenant_id: string, requestId: string): Promise<RoutedSignatureProvider>;
  /** The provider frozen on the request for this document revision (Aramo Sign for pre-routing requests). */
  forDocument(tenant_id: string, document_id: string, document_revision_id: string): Promise<RoutedSignatureProvider>;
  recordRoute(input: {
    tenant_id: string;
    document_id: string;
    document_revision_id: string;
    provider: SignatureProviderKey;
    provider_envelope_ref: string;
  }): Promise<void>;
}

/** A fixed Aramo Sign router: for tests and fakes that exercise signing mechanics only. */
export function staticSignatureRouter(port: SignatureProviderPort): SignatureRouter {
  const routed: RoutedSignatureProvider = { provider: 'aramo_sign', port };
  return {
    forNewSend: async () => routed,
    forDocument: async () => routed,
    recordRoute: async () => undefined,
  };
}
