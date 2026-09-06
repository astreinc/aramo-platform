import { Inject, Injectable } from '@nestjs/common';
import {
  IntegrationConnectionService,
  SECRETS_MANAGER_PORT,
  deriveConnectorSecretManagerId,
  type SecretsManagerPort,
} from '@aramo/integration';
import { MICROSOFT_PROVIDER_KEY } from '@aramo/microsoft-graph';

// COMM-C2B — resolves the tenant's Microsoft connection + confidential-client
// config for the composition root. Microsoft-specific config (client_id,
// authority) lives ONLY here (R20). The client secret is read from the connector
// secret path (R3) and never persisted/returned.

interface MicrosoftConnectionConfig {
  client_id?: string;
  authority_tenant?: string;
}

export interface ResolvedMicrosoftConfig {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorityTenant?: string;
}

@Injectable()
export class MicrosoftConfigResolver {
  constructor(
    private readonly connections: IntegrationConnectionService,
    @Inject(SECRETS_MANAGER_PORT) private readonly secrets: SecretsManagerPort,
  ) {}

  redirectUri(): string {
    const uri = process.env['MSGRAPH_REDIRECT_URI'] ?? '';
    if (uri.length === 0) {
      throw new Error('MSGRAPH_REDIRECT_URI is not configured');
    }
    return uri;
  }

  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** The tenant's usable Microsoft connection id (explicit or resolved), or throw. */
  async resolveConnectionId(tenantId: string, connectionId?: string): Promise<string> {
    if (connectionId !== undefined && connectionId.length > 0) {
      await this.connections.getConnection(tenantId, connectionId); // tenant-safe existence
      return connectionId;
    }
    const conn = await this.connections.findConnectionByProviderKey(tenantId, MICROSOFT_PROVIDER_KEY);
    if (conn === null) {
      throw new Error('no microsoft connection configured for tenant');
    }
    return conn.id;
  }

  async resolveConfig(
    tenantId: string,
    connectionId: string,
    withSecret: boolean,
  ): Promise<ResolvedMicrosoftConfig> {
    const cfg = ((await this.connections.getConnectionConfig(tenantId, connectionId)) ??
      {}) as MicrosoftConnectionConfig;
    let clientSecret: string | undefined;
    if (withSecret) {
      clientSecret = await this.secrets.getSecretValue(
        deriveConnectorSecretManagerId({
          env: process.env['ARAMO_ENV'] ?? '',
          tenant_id: tenantId,
          connection_id: connectionId,
        }),
      );
    }
    return { clientId: cfg.client_id ?? '', clientSecret, authorityTenant: cfg.authority_tenant };
  }
}
