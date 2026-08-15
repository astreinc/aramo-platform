import { Inject, Injectable } from '@nestjs/common';

import {
  assertConnectorSecretRefBinding,
  deriveConnectorSecretManagerId,
} from './connector-secret-ref.js';
import { SECRETS_MANAGER_PORT, type SecretsManagerPort } from './secrets-manager.port.js';

// T8-CONNECTOR-A — tenant-bound connector secret resolution (directive §7/§8,
// Architect check #1).
//
// Resolution ALWAYS begins from (tenant_id, connection_id), loads the connection
// TENANT-SAFELY (a connection owned by another tenant is simply NOT FOUND), then
// derives the AWS Secrets Manager id SERVER-SIDE from the connection's OWN
// tenant_id/id. There is deliberately NO code path that accepts a caller-supplied
// secret path. Cross-tenant substitution is structurally impossible.

/** The minimal tenant-safe connection loader the resolver needs. */
export interface ConnectionSecretLoaderPort {
  /**
   * Load a connection by id SCOPED TO the given tenant. MUST return null when
   * the connection does not exist OR belongs to a different tenant (tenant-safe).
   */
  findConnectionForTenant(
    tenantId: string,
    connectionId: string,
  ): Promise<{
    readonly id: string;
    readonly tenant_id: string;
    readonly secret_ref: string | null;
  } | null>;
}

export const CONNECTION_SECRET_LOADER = Symbol('CONNECTION_SECRET_LOADER');

export type ConnectorSecretErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTOR_SECRET_UNAVAILABLE'
  | 'CONNECTOR_SECRET_BINDING_MISMATCH';

/** Typed internal resolution failure (NOT a governed HTTP ErrorCode). */
export class ConnectorSecretResolutionError extends Error {
  constructor(readonly code: ConnectorSecretErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorSecretResolutionError';
  }
}

@Injectable()
export class ConnectorSecretResolver {
  constructor(
    @Inject(CONNECTION_SECRET_LOADER)
    private readonly connections: ConnectionSecretLoaderPort,
    @Inject(SECRETS_MANAGER_PORT)
    private readonly secretsManager: SecretsManagerPort,
  ) {}

  /**
   * Resolve the raw credential for executing a connection. The returned value is
   * ephemeral and MUST NOT be persisted or logged (see the redaction helper).
   */
  async resolveForExecution(args: {
    tenant_id: string;
    connection_id: string;
  }): Promise<string> {
    // 1. Tenant-safe load — a connection belonging to another tenant is NOT
    //    FOUND, so we never even derive a foreign-tenant secret id.
    const conn = await this.connections.findConnectionForTenant(
      args.tenant_id,
      args.connection_id,
    );
    if (conn === null) {
      throw new ConnectorSecretResolutionError(
        'CONNECTION_NOT_FOUND',
        'connection not found for tenant',
      );
    }

    // 2. Credentials must have been configured.
    if (conn.secret_ref === null) {
      throw new ConnectorSecretResolutionError(
        'CONNECTOR_SECRET_UNAVAILABLE',
        'connection has no configured secret',
      );
    }

    // 3. Defensive binding assertion — the stored ref must encode THIS
    //    connection's (tenant_id, connection_id). Belt-and-suspenders on the
    //    tenant-safe load above.
    try {
      assertConnectorSecretRefBinding(conn.secret_ref, {
        tenant_id: conn.tenant_id,
        connection_id: conn.id,
      });
    } catch {
      throw new ConnectorSecretResolutionError(
        'CONNECTOR_SECRET_BINDING_MISMATCH',
        'secret_ref does not bind to this connection',
      );
    }

    // 4. Derive the SM id from the CONNECTION'S OWN tenant_id/id (never client
    //    input), then resolve. env-scoped + tenant-namespaced + server-controlled.
    const secretId = deriveConnectorSecretManagerId({
      env: process.env['ARAMO_ENV'] ?? '',
      tenant_id: conn.tenant_id,
      connection_id: conn.id,
    });
    return this.secretsManager.getSecretValue(secretId);
  }
}
