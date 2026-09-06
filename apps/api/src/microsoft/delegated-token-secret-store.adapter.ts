import { Inject, Injectable } from '@nestjs/common';
import {
  SECRETS_MANAGER_PORT,
  SECRETS_MANAGER_WRITER,
  type SecretsManagerPort,
  type SecretsManagerWriterPort,
} from '@aramo/integration';
import type {
  DelegatedTokenBinding,
  DelegatedTokenBundle,
  DelegatedTokenStorePort,
} from '@aramo/microsoft-graph';

// COMM-C2B — delegated token custody (R3/R4/R7). Token bundles live ONLY in AWS
// Secrets Manager, under a server-derived, tenant+identity-namespaced id that is
// distinct from the connector-credential namespace. Postgres never sees a token.
// Revoke writes a tombstone so the bundle can no longer be resolved for new
// actions (R7). The id is derived from the binding's OWN (tenant, identity) —
// never client input — so no caller can point at another binding's secret.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOMBSTONE = '{"_tombstone":true}';

function deriveDelegatedSecretId(binding: DelegatedTokenBinding): string {
  const env = process.env['ARAMO_ENV'] ?? '';
  if (env.length === 0) {
    throw new Error('ARAMO_ENV not set');
  }
  if (!UUID_RE.test(binding.tenant_id) || !UUID_RE.test(binding.provider_identity_id)) {
    throw new Error('invalid delegated token binding id');
  }
  return `aramo/${env}/msgraph-delegated/${binding.tenant_id}/${binding.provider_identity_id}`;
}

@Injectable()
export class DelegatedTokenSecretStoreAdapter implements DelegatedTokenStorePort {
  constructor(
    @Inject(SECRETS_MANAGER_WRITER) private readonly writer: SecretsManagerWriterPort,
    @Inject(SECRETS_MANAGER_PORT) private readonly reader: SecretsManagerPort,
  ) {}

  async write(binding: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void> {
    await this.writer.putSecretValue(deriveDelegatedSecretId(binding), JSON.stringify(bundle));
  }

  async read(binding: DelegatedTokenBinding): Promise<DelegatedTokenBundle | null> {
    let raw: string;
    try {
      raw = await this.reader.getSecretValue(deriveDelegatedSecretId(binding));
    } catch {
      return null; // absent secret = no custody
    }
    if (raw.length === 0 || raw === TOMBSTONE) {
      return null;
    }
    const parsed = JSON.parse(raw) as DelegatedTokenBundle & { _tombstone?: boolean };
    return parsed._tombstone === true ? null : parsed;
  }

  async rotate(binding: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void> {
    await this.write(binding, bundle);
  }

  async remove(binding: DelegatedTokenBinding): Promise<void> {
    // Tombstone (not delete) so the id stays stable and audit history is intact.
    await this.writer.putSecretValue(deriveDelegatedSecretId(binding), TOMBSTONE);
  }
}
