import { Injectable } from '@nestjs/common';
import { ConnectorSecretResolver, IntegrationConnectionService } from '@aramo/integration';

import type { ExternalProviderKey, ProviderConnectionState } from './external-signature-adapter.js';

// Multi-Provider directive §E/§G — external provider tokens in the approved custody:
// the tenant's IntegrationConnection (provider_key = provider) holds non-secret
// account data; the token bundle lives write-only in the existing connector
// Secrets Manager namespace (no new IAM). Tokens never reach Postgres, logs or the
// browser. Disconnect writes a tombstone and disables the connection.

export interface ProviderTokens {
  readonly access_token: string;
  readonly refresh_token: string;
  /** epoch ms */
  readonly expires_at: number;
  readonly account_id: string;
  /** Provider API host for this account (DocuSign base_uri, Adobe api_access_point). */
  readonly base_uri: string;
}

const TOMBSTONE = '{"_tombstone":true}';

@Injectable()
export class ProviderCredentialStore {
  constructor(
    private readonly connections: IntegrationConnectionService,
    private readonly secrets: ConnectorSecretResolver,
  ) {}

  private async latest(tenant_id: string, provider: ExternalProviderKey) {
    const rows = (await this.connections.listConnections(tenant_id)).filter((c) => c.provider_key === provider && c.status !== 'disabled');
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return rows[0] ?? null;
  }

  async load(tenant_id: string, provider: ExternalProviderKey): Promise<ProviderTokens | null> {
    const conn = await this.latest(tenant_id, provider);
    if (conn === null || !conn.has_secret) return null;
    const raw = await this.secrets.resolveForExecution({ tenant_id, connection_id: conn.id });
    if (raw === TOMBSTONE) return null;
    return JSON.parse(raw) as ProviderTokens;
  }

  async save(tenant_id: string, provider: ExternalProviderKey, tokens: ProviderTokens, provider_account_id: string): Promise<void> {
    let conn = await this.latest(tenant_id, provider);
    if (conn === null) {
      conn = await this.connections.createConnection({
        tenant_id,
        provider_key: provider,
        provider_account_id,
        config: { account_id: tokens.account_id, base_uri: tokens.base_uri },
      });
    } else if (conn.provider_account_id !== provider_account_id) {
      await this.connections.updateConnection(tenant_id, conn.id, {
        provider_account_id,
        config: { account_id: tokens.account_id, base_uri: tokens.base_uri },
      });
    }
    await this.connections.setCredential({ tenant_id, id: conn.id, credential: JSON.stringify(tokens) });
    await this.connections.enable(tenant_id, conn.id);
  }

  async markDegraded(tenant_id: string, provider: ExternalProviderKey, code: string, summary: string): Promise<void> {
    const conn = await this.latest(tenant_id, provider);
    if (conn !== null) await this.connections.recordExecutionFailure(tenant_id, conn.id, code, summary);
  }

  async state(tenant_id: string, provider: ExternalProviderKey): Promise<ProviderConnectionState> {
    const conn = await this.latest(tenant_id, provider);
    if (conn === null || !conn.has_secret) return 'NOT_CONNECTED';
    if (conn.status === 'degraded') return 'DEGRADED';
    return conn.status === 'active' ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  /** The signed provider account the tenant connected (binds provider callbacks to the tenant). */
  async accountMatches(tenant_id: string, provider: ExternalProviderKey, provider_account_id: string): Promise<boolean> {
    const conn = await this.latest(tenant_id, provider);
    return conn !== null && conn.status !== 'disabled' && conn.provider_account_id === provider_account_id;
  }

  async disconnect(tenant_id: string, provider: ExternalProviderKey): Promise<void> {
    const conn = await this.latest(tenant_id, provider);
    if (conn === null) return;
    await this.connections.setCredential({ tenant_id, id: conn.id, credential: TOMBSTONE });
    await this.connections.disable(tenant_id, conn.id);
  }
}
