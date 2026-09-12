import { Inject, Injectable } from '@nestjs/common';
import {
  IntegrationConnectionService,
  SECRETS_MANAGER_PORT,
  deriveConnectorSecretManagerId,
  type IntegrationConnectionView,
  type SecretsManagerPort,
} from '@aramo/integration';
import { MICROSOFT_PROVIDER_KEY } from '@aramo/microsoft-graph';

import { MicrosoftProviderNotConfiguredError } from './microsoft-provider-not-configured.error.js';

// COMM-C2B — resolves the tenant's Microsoft connection + confidential-client
// config for the composition root. Microsoft-specific config (client_id,
// authority) lives ONLY here (R20). The client secret is read from the connector
// secret path (R3) and never persisted/returned.
//
// COMM PART B — this resolver also OWNS tenant-admin establishment of the
// Microsoft connection: create/update the provider-neutral IntegrationConnection
// (config = client_id + authority_tenant) and set the confidential-client secret
// WRITE-ONLY into the connector secret path (never Postgres/return/log). This is
// the application-credential custody, DISTINCT from C2B's per-recruiter delegated
// token custody (msgraph-delegated path).

interface MicrosoftConnectionConfig {
  client_id?: string;
  authority_tenant?: string;
}

export interface ResolvedMicrosoftConfig {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorityTenant?: string;
}

/** Tenant-admin establishment input (PART B). client_secret is optional on update. */
export interface ConfigureMicrosoftConnectionInput {
  readonly client_id: string;
  readonly authority_tenant: string;
  readonly client_secret?: string;
}

export interface MicrosoftConnectionSummary {
  readonly connection_id: string;
  readonly has_secret: boolean;
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

  /** The tenant's Microsoft connection (secret-free view), or null when unconfigured. */
  async findConnection(tenantId: string): Promise<IntegrationConnectionView | null> {
    return this.connections.findConnectionByProviderKey(tenantId, MICROSOFT_PROVIDER_KEY);
  }

  /**
   * PART B — tenant-admin create/update of the Microsoft connection. Non-secret
   * config (client_id + authority_tenant) is stored on the governed
   * IntegrationConnection; the client secret (when supplied) is written WRITE-ONLY
   * to the connector secret path via IntegrationConnectionService.setCredential —
   * never persisted to Postgres, returned, or logged. Tenant isolation is enforced
   * by IntegrationConnectionService (every op is tenant-scoped).
   */
  async configureConnection(
    tenantId: string,
    input: ConfigureMicrosoftConnectionInput,
  ): Promise<MicrosoftConnectionSummary> {
    const config: MicrosoftConnectionConfig = {
      client_id: input.client_id,
      authority_tenant: input.authority_tenant,
    };
    const existing = await this.connections.findConnectionByProviderKey(tenantId, MICROSOFT_PROVIDER_KEY);
    const connection =
      existing === null
        ? await this.connections.createConnection({
            tenant_id: tenantId,
            provider_key: MICROSOFT_PROVIDER_KEY,
            config,
          })
        : await this.connections.updateConnection(tenantId, existing.id, { config });

    if (input.client_secret !== undefined && input.client_secret.length > 0) {
      // Write-only: raw secret → Secrets Manager only (rotates/replaces on update).
      // Ordering note: the connection row is created above BEFORE this secret
      // write (the SM secret id is derived from the connection_id, so the row must
      // exist first). If this write fails (e.g. a Secrets Manager IAM denial), the
      // config row is left without a secret_ref — that is NOT masked anymore (the
      // controller surfaces the real error as 500), and it SELF-HEALS on the next
      // save, which takes the updateConnection path (no duplicate row).
      await this.connections.setCredential({
        tenant_id: tenantId,
        id: connection.id,
        credential: input.client_secret,
      });
      return { connection_id: connection.id, has_secret: true };
    }
    return { connection_id: connection.id, has_secret: existing?.has_secret ?? false };
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
      throw new MicrosoftProviderNotConfiguredError('no microsoft connection configured for tenant');
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
