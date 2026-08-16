// T8-CONNECTOR-A — the write side of the Secrets Manager port (directive §7/§34,
// Architect check #2). Injected ONLY into the connection service's write-only
// credential-set flow. The secret id is ALWAYS server-derived from a tenant-owned
// connection row; callers never supply a path. There is deliberately NO read
// method here — GET flows use the resolver's read port and never return secrets.

export const SECRETS_MANAGER_WRITER = Symbol('SECRETS_MANAGER_WRITER');

export interface SecretsManagerWriterPort {
  /** Create or replace the secret value at a (server-derived) secret id. */
  putSecretValue(secretId: string, value: string): Promise<void>;
}
