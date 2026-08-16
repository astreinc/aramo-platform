// T8-CONNECTOR-A — connector-management request DTOs (directive §34). All
// provider-neutral; NO provider-specific credential fields. Secret material is
// accepted ONLY on the dedicated write-only credential endpoint and is never
// returned.

export interface CreateIntegrationConnectionDto {
  /** Normalized, extensible provider key — NEVER a frozen vendor enum. */
  provider_key: string;
  /**
   * Optional provider-neutral account/instance identifier the tenant recognizes
   * (NOT a credential). Free-form connection `config` is intentionally NOT part
   * of the Connector-A API surface (no provider selected → no config shape);
   * it is a Connector-B concern under provider-specific authority.
   */
  provider_account_id?: string | null;
}

export interface UpdateIntegrationConnectionDto {
  provider_account_id?: string | null;
}

/**
 * WRITE-ONLY credential set (directive §7/§34). The raw value is sent once to the
 * server, stored in Secrets Manager under a server-derived id, and NEVER returned.
 */
export interface SetCredentialDto {
  credential: string;
}
