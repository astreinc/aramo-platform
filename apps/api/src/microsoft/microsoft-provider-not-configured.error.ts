// COMM-C2B — thrown when a Microsoft operation is attempted for a tenant that has
// no usable provider connection. This is a DISTINCT, expected condition (the
// tenant simply hasn't set up Microsoft yet) — NOT an unexpected/infra failure.
// The controller maps ONLY this to 409 MICROSOFT_PROVIDER_NOT_CONFIGURED; every
// other unknown error (e.g. a Secrets Manager AccessDeniedException) is logged
// and surfaced as 500 INTERNAL_ERROR rather than being masked as a misleading
// "provider not configured" 409.
export class MicrosoftProviderNotConfiguredError extends Error {
  constructor(message = 'no usable microsoft provider connection for tenant') {
    super(message);
    this.name = 'MicrosoftProviderNotConfiguredError';
  }
}
