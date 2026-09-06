// COMM-C2B — Microsoft 365 provider identity within the existing Integration/
// Communications provider model (R10). Registered as an IntegrationConnection
// `provider_key`; exposes provider-neutral capabilities (email, meeting). No
// second provider-configuration system. Microsoft-specific keys never enter
// recruiting or Engagement policy contracts (R10/R20).

/** The normalized IntegrationConnection.provider_key for Microsoft 365 (Graph). */
export const MICROSOFT_PROVIDER_KEY = 'microsoft_graph' as const;

/** Provider-neutral capabilities this provider delivers in C2B. */
export const MICROSOFT_CAPABILITIES = Object.freeze({
  email: true,
  meeting: true,
});

export type MicrosoftCapability = keyof typeof MICROSOFT_CAPABILITIES;
