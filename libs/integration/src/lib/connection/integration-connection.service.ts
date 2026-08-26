import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConnectorAuditLog, CONNECTOR_AUDIT_EVENTS } from '../observability/connector-audit.js';
import {
  normalizeProviderKey,
  toConnectionView,
  type IntegrationConnectionView,
} from '../domain/integration-connection.js';
import {
  buildConnectorSecretRef,
  deriveConnectorSecretManagerId,
} from '../secrets/connector-secret-ref.js';
import {
  SECRETS_MANAGER_WRITER,
  type SecretsManagerWriterPort,
} from '../secrets/secrets-manager-writer.port.js';

import { IntegrationConnectionRepository } from './integration-connection.repository.js';
import {
  resolveTransition,
  type ConnectionIntent,
} from './connection-lifecycle.js';

// T8-CONNECTOR-A — connection management service (directive §13/§14/§22/§34,
// Architect checks #1 + #2).
//   * Every status change routes through the lifecycle legality gate — status is
//     never an arbitrary writable field.
//   * Credential set is WRITE-ONLY: the server generates the opaque secret_ref
//     and derives the SM id; the raw value is never persisted, returned, or logged.
//   * All reads/writes are tenant-scoped; a cross-tenant id is NOT FOUND.

export type ConnectionServiceErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_ILLEGAL_TRANSITION'
  | 'CONNECTOR_CONFIGURATION_INVALID';

export class ConnectionServiceError extends Error {
  constructor(readonly code: ConnectionServiceErrorCode, message: string) {
    super(message);
    this.name = 'ConnectionServiceError';
  }
}

@Injectable()
export class IntegrationConnectionService {
  constructor(
    private readonly repo: IntegrationConnectionRepository,
    @Inject(SECRETS_MANAGER_WRITER)
    private readonly secretsWriter: SecretsManagerWriterPort,
    @Optional() private readonly audit?: ConnectorAuditLog,
  ) {}

  async createConnection(args: {
    tenant_id: string;
    provider_key: string;
    config?: unknown;
    provider_account_id?: string | null;
  }): Promise<IntegrationConnectionView> {
    const provider_key = normalizeProviderKey(args.provider_key);
    const row = await this.repo.create({
      tenant_id: args.tenant_id,
      provider_key,
      config: args.config,
      provider_account_id: args.provider_account_id ?? null,
    });
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.CONNECTION_CREATED, {
      tenant_id: row.tenant_id,
      connection_id: row.id,
      provider_key: row.provider_key,
    });
    return toConnectionView(row);
  }

  async listConnections(tenantId: string): Promise<IntegrationConnectionView[]> {
    const rows = await this.repo.listForTenant(tenantId);
    return rows.map(toConnectionView);
  }

  async getConnection(tenantId: string, id: string): Promise<IntegrationConnectionView> {
    const row = await this.requireConnection(tenantId, id);
    return toConnectionView(row);
  }

  /**
   * COMM-B3 — resolve the tenant's USABLE (configured|active) connection for a
   * provider_key, or null. Provider-neutral: the caller supplies the key. Used
   * by the composition root to bind a communications provider to its connection
   * without duplicating provider-selection logic in apps/api.
   */
  async findConnectionByProviderKey(
    tenantId: string,
    providerKey: string,
  ): Promise<IntegrationConnectionView | null> {
    const row = await this.repo.findByProviderKeyForTenant(tenantId, providerKey);
    return row === null ? null : toConnectionView(row);
  }

  /**
   * COMM-B6 — resolve a USABLE connection by the SIGNED provider account identity
   * (tenant-agnostic; the account id selects the tenant AFTER webhook signature
   * verification). Returns the secret-free view (carries tenant_id + id). Null =
   * no usable connection for that account → caller accepts + no-ops (no oracle).
   */
  async findConnectionByProviderAccountId(
    providerKey: string,
    providerAccountId: string,
  ): Promise<IntegrationConnectionView | null> {
    const row = await this.repo.findByProviderAccountId(providerKey, providerAccountId);
    return row === null ? null : toConnectionView(row);
  }

  /**
   * WRITE-ONLY credential set (directive §7/§34). The client supplies a raw
   * credential value ONCE; the server generates the opaque secret_ref, derives
   * the tenant-namespaced SM id, and stores the value in Secrets Manager. The
   * raw value is never persisted to Postgres nor returned. Response is the
   * secret-free view.
   */
  async setCredential(args: {
    tenant_id: string;
    id: string;
    credential: string;
  }): Promise<IntegrationConnectionView> {
    const row = await this.requireConnection(args.tenant_id, args.id);
    // Legality (all states may (re)configure) — routed through the gate for
    // uniformity; drops the connection to `configured` pending re-enable.
    resolveTransition(row.status, 'configure');

    const secretId = deriveConnectorSecretManagerId({
      env: process.env['ARAMO_ENV'] ?? '',
      tenant_id: row.tenant_id,
      connection_id: row.id,
    });
    // Value goes ONLY to Secrets Manager — never to Postgres/logs/audit.
    await this.secretsWriter.putSecretValue(secretId, args.credential);

    const secretRef = buildConnectorSecretRef({ tenant_id: row.tenant_id, connection_id: row.id });
    await this.repo.setSecretRef(args.tenant_id, args.id, secretRef);

    // Secret-free: records that a credential was set, NEVER the value.
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.CREDENTIAL_SET, {
      tenant_id: row.tenant_id,
      connection_id: row.id,
    });
    return toConnectionView({ ...row, secret_ref: secretRef, status: 'configured' });
  }

  async updateConnection(
    tenantId: string,
    id: string,
    patch: { config?: unknown; provider_account_id?: string | null },
  ): Promise<IntegrationConnectionView> {
    await this.requireConnection(tenantId, id);
    await this.repo.updateConfig(tenantId, id, patch);
    const fresh = await this.requireConnection(tenantId, id);
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.CONNECTION_UPDATED, { tenant_id: tenantId, connection_id: id });
    return toConnectionView(fresh);
  }

  async enable(tenantId: string, id: string): Promise<IntegrationConnectionView> {
    const row = await this.requireConnection(tenantId, id);
    if (row.secret_ref === null) {
      throw new ConnectionServiceError(
        'CONNECTOR_CONFIGURATION_INVALID',
        'cannot enable a connection with no configured credential',
      );
    }
    const view = await this.applyIntent(row, 'enable');
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.CONNECTION_ENABLED, { tenant_id: tenantId, connection_id: id });
    return view;
  }

  async disable(tenantId: string, id: string): Promise<IntegrationConnectionView> {
    // Disable preserves ALL history (no delete) — administrative deactivation.
    const row = await this.requireConnection(tenantId, id);
    const view = await this.applyIntent(row, 'disable');
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.CONNECTION_DISABLED, { tenant_id: tenantId, connection_id: id });
    return view;
  }

  /** Execution-path recovery (directive §14): governed degraded → active. */
  async recordExecutionSuccess(tenantId: string, id: string): Promise<void> {
    await this.repo.recordSuccess(tenantId, id);
  }

  /** Execution-path failure (directive §14): governed → degraded, bounded error. */
  async recordExecutionFailure(
    tenantId: string,
    id: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    await this.repo.recordError(tenantId, id, errorCode, errorSummary);
  }

  private async applyIntent(
    row: { status: IntegrationConnectionView['status']; tenant_id: string; id: string },
    intent: ConnectionIntent,
  ): Promise<IntegrationConnectionView> {
    let target;
    try {
      target = resolveTransition(row.status, intent);
    } catch {
      throw new ConnectionServiceError(
        'CONNECTION_ILLEGAL_TRANSITION',
        `illegal transition ${intent} from ${row.status}`,
      );
    }
    await this.repo.setStatus(row.tenant_id, row.id, target);
    const fresh = await this.requireConnection(row.tenant_id, row.id);
    return toConnectionView(fresh);
  }

  private async requireConnection(tenantId: string, id: string) {
    const row = await this.repo.findByIdForTenant(tenantId, id);
    if (row === null) {
      throw new ConnectionServiceError('CONNECTION_NOT_FOUND', 'connection not found for tenant');
    }
    return row;
  }
}
