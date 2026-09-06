import type { DelegatedTokenBundle } from '../domain/delegated-token.js';

// COMM-C2B — delegated token custody port (R3/R4). The concrete adapter is
// backed by AWS Secrets Manager via the existing governed secret path. Bundles
// are keyed by the (tenant, provider-identity) binding so one recruiter's tokens
// are physically separate from another's; a read is always binding-scoped, so
// Recruiter A can never resolve Recruiter B's bundle (R6/§4.6).

export const DELEGATED_TOKEN_STORE = 'DELEGATED_TOKEN_STORE';

export interface DelegatedTokenBinding {
  readonly tenant_id: string;
  readonly provider_identity_id: string;
}

export interface DelegatedTokenStorePort {
  write(binding: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void>;
  read(binding: DelegatedTokenBinding): Promise<DelegatedTokenBundle | null>;
  /** Atomic rotate on refresh (R4) — replaces the stored bundle in place. */
  rotate(binding: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void>;
  /** Disable custody so the bundle can no longer be used for new actions (R7). */
  remove(binding: DelegatedTokenBinding): Promise<void>;
}
