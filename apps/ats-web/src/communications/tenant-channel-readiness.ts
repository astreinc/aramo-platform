import { getMicrosoftProviderStatus } from '../microsoft/microsoft-api';

import { listCommunicationProviders } from './provider-config-api';

// COMM PART C (C6/§10) — Tenant OPERATIONAL readiness per evidence channel,
// distinct from global platform capability. A channel is "ready" only when the
// Tenant has a CONFIGURED provider that can actually produce that channel's
// evidence. Composed on the FE from the communications provider list (voice) +
// the Microsoft provider status (email) — the Engagement Policy contract stays
// provider-neutral; this signal never crosses into the policy payload.

export interface TenantChannelReadiness {
  /** A configured provider can produce voice evidence for this Tenant. */
  readonly voice: boolean;
  /** A configured provider can produce email evidence for this Tenant. */
  readonly email: boolean;
}

export async function getTenantChannelReadiness(): Promise<TenantChannelReadiness> {
  const [providers, ms] = await Promise.all([
    listCommunicationProviders().catch(() => []),
    getMicrosoftProviderStatus().catch(() => null),
  ]);
  const voice = providers.some(
    (p) =>
      (p.configuration_state === 'configured' || p.configuration_state === 'active') &&
      p.capabilities.voice.supported &&
      p.capabilities.voice.execution === 'available',
  );
  const email = ms?.configuration_state === 'CONFIGURED';
  return { voice, email };
}
