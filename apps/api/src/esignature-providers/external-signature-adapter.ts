import { AramoError } from '@aramo/common';
import type { SignatureProviderPort } from '@aramo/documents-contracts';

// Multi-Provider directive §F/§G — what an external e-signature provider adds to the
// provider-neutral SignatureProviderPort: tenant-authorized connection (OAuth),
// connection health, and retrieval of the provider's completion artifacts.

export type ExternalProviderKey = 'docusign' | 'adobe_sign';
export type ProviderConnectionState = 'CONNECTED' | 'NOT_CONNECTED' | 'DEGRADED';

export interface ProviderCompletion {
  /** The provider's signed document. */
  readonly executed_pdf: Buffer;
  /** The provider's own completion evidence, stored under its own kind. */
  readonly evidence_pdf: Buffer;
  readonly evidence_kind: string;
}

export interface ExternalSignatureAdapter extends SignatureProviderPort {
  readonly provider: ExternalProviderKey;
  connectionState(tenant_id: string): Promise<ProviderConnectionState>;
  authorizeUrl(input: { state: string; code_verifier: string }): string;
  completeAuthorization(input: { tenant_id: string; code: string; code_verifier: string; callback_params?: Record<string, string> }): Promise<void>;
  disconnect(tenant_id: string): Promise<void>;
  /** The completion artifacts, or null when the provider does not report the envelope completed. */
  fetchCompletion(tenant_id: string, envelope_ref: string): Promise<ProviderCompletion | null>;
}

export function isExternalAdapter(port: SignatureProviderPort): port is ExternalSignatureAdapter {
  return typeof (port as Partial<ExternalSignatureAdapter>).connectionState === 'function';
}

/** A typed operational failure: never a silent fallback to another provider. */
export function providerFailure(
  provider: ExternalProviderKey,
  reason: 'PROVIDER_REFUSED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_DISCONNECTED',
  extra: Record<string, unknown> = {},
): AramoError {
  const message =
    reason === 'PROVIDER_REFUSED'
      ? 'The e-signature provider refused the request'
      : reason === 'PROVIDER_DISCONNECTED'
        ? 'The e-signature provider connection needs to be reconnected'
        : 'The e-signature provider is not reachable right now';
  return new AramoError('ESIGN_SEND_UNAVAILABLE', message, 409, { requestId: '', details: { reason, provider, ...extra } });
}
