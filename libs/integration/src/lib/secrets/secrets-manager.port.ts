// T8-CONNECTOR-A — the narrow Secrets Manager port (directive §7).
//
// This is an INTERNAL server-side abstraction. It is injected ONLY into the
// connector secret resolver/writer — never into controllers, orchestrators, or
// any caller that could pass a client-controlled path. The secret id handed to
// this port is ALWAYS derived server-side from a tenant-scoped connection row
// (see ConnectorSecretResolver); this port never receives client input.

/** DI token for the Secrets Manager port. */
export const SECRETS_MANAGER_PORT = Symbol('SECRETS_MANAGER_PORT');

export interface SecretsManagerPort {
  /** Resolve a secret value by its (server-derived) secret id. */
  getSecretValue(secretId: string): Promise<string>;
}
