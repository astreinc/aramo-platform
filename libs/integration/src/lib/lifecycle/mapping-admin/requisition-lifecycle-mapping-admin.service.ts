import { Injectable, Optional } from '@nestjs/common';

import { IntegrationConnectionRepository } from '../../connection/integration-connection.repository.js';
import { ConnectorAuditLog } from '../../observability/connector-audit.js';

import {
  MAPPING_ADMIN_AUTHORITY_MODE,
  MAPPING_DISPOSITION,
  MAPPING_SET_STATUS,
  isMappingAdminAllowedAction,
  normalizeProviderState,
  type DraftMappingRowInput,
  type MappingRowView,
  type MappingSetDetailView,
  type MappingSetSummaryView,
  type MappingValidationIssue,
} from './mapping-admin.domain.js';
import {
  ActiveSetConflictError,
  RequisitionLifecycleMappingAdminRepository,
  type MappingRow,
  type MappingSetRow,
  type PersistDraftRow,
} from './requisition-lifecycle-mapping-admin.repository.js';

// L1-D3-A — the mapping-set administration SERVICE. Application logic for the
// versioned, connection-scoped mapping configuration: list/get/active, create a
// draft, edit a DRAFT only, validate, and ATOMICALLY activate a version. Every
// mutation is tenant-scoped (a cross-tenant / unknown connection is NOT FOUND) and
// audited. No requisition write, no policy — the runtime reconciler consumes the
// active set separately.

/** Mapping-admin audit event discriminators (structured-log; no new persisted
 * type, per the ConnectorAuditLog convention). */
export const MAPPING_ADMIN_AUDIT_EVENTS = {
  DRAFT_CREATED: 'connector.lifecycle_mapping.draft_created',
  DRAFT_UPDATED: 'connector.lifecycle_mapping.draft_updated',
  ACTIVATED: 'connector.lifecycle_mapping.activated',
} as const;

export type MappingAdminServiceErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'MAPPING_SET_NOT_FOUND'
  | 'NO_ACTIVE_MAPPING_SET'
  | 'MAPPING_SET_NOT_DRAFT'
  | 'MAPPING_SET_INVALID'
  | 'ACTIVE_SET_CONFLICT';

export class MappingAdminServiceError extends Error {
  constructor(
    readonly code: MappingAdminServiceErrorCode,
    message: string,
    readonly issues?: MappingValidationIssue[],
  ) {
    super(message);
    this.name = 'MappingAdminServiceError';
  }
}

@Injectable()
export class RequisitionLifecycleMappingAdminService {
  constructor(
    private readonly connections: IntegrationConnectionRepository,
    private readonly repo: RequisitionLifecycleMappingAdminRepository,
    @Optional() private readonly audit?: ConnectorAuditLog,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listSets(tenantId: string, connectionId: string): Promise<MappingSetSummaryView[]> {
    await this.requireConnection(tenantId, connectionId);
    const sets = await this.repo.listSets(tenantId, connectionId);
    return sets.map((s) => this.toSummary(s));
  }

  async getSet(
    tenantId: string,
    connectionId: string,
    version: number,
  ): Promise<MappingSetDetailView> {
    await this.requireConnection(tenantId, connectionId);
    const set = await this.requireSet(tenantId, connectionId, version);
    const rows = await this.repo.rowsForSet(set.id);
    return this.toDetail(set, rows);
  }

  async getActiveSet(tenantId: string, connectionId: string): Promise<MappingSetDetailView> {
    await this.requireConnection(tenantId, connectionId);
    const active = await this.repo.findActiveSet(tenantId, connectionId);
    if (active === null) {
      throw new MappingAdminServiceError(
        'NO_ACTIVE_MAPPING_SET',
        'no active mapping set for this connection',
      );
    }
    const rows = await this.repo.rowsForSet(active.id);
    return this.toDetail(active, rows);
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  /** Create a new DRAFT set at version = max+1 with the supplied rows (possibly
   * empty). The rows are validated + normalized before persistence. */
  async createDraft(
    tenantId: string,
    connectionId: string,
    actorId: string,
    rows: DraftMappingRowInput[],
  ): Promise<MappingSetDetailView> {
    await this.requireConnection(tenantId, connectionId);
    const persistRows = this.prepareRows(rows);
    const version = (await this.repo.maxVersion(tenantId, connectionId)) + 1;
    const set = await this.repo.createDraftSet({
      tenant_id: tenantId,
      connection_id: connectionId,
      version,
      created_by: actorId,
      rows: persistRows,
    });
    this.audit?.emit(MAPPING_ADMIN_AUDIT_EVENTS.DRAFT_CREATED, {
      tenant_id: tenantId,
      connection_id: connectionId,
      mapping_set_id: set.id,
      version,
      actor_id: actorId,
      row_count: persistRows.length,
    });
    return this.getSet(tenantId, connectionId, version);
  }

  /** Replace the rows of a DRAFT set. Editing a non-draft (active/historical) set
   * is REJECTED — active/historical versions are immutable. */
  async replaceDraftRows(
    tenantId: string,
    connectionId: string,
    version: number,
    actorId: string,
    rows: DraftMappingRowInput[],
  ): Promise<MappingSetDetailView> {
    await this.requireConnection(tenantId, connectionId);
    const set = await this.requireSet(tenantId, connectionId, version);
    this.requireDraft(set);
    const persistRows = this.prepareRows(rows);
    await this.repo.replaceDraftRows({
      tenant_id: tenantId,
      connection_id: connectionId,
      set_id: set.id,
      version: set.version,
      rows: persistRows,
    });
    this.audit?.emit(MAPPING_ADMIN_AUDIT_EVENTS.DRAFT_UPDATED, {
      tenant_id: tenantId,
      connection_id: connectionId,
      mapping_set_id: set.id,
      version,
      actor_id: actorId,
      row_count: persistRows.length,
    });
    return this.getSet(tenantId, connectionId, version);
  }

  // -------------------------------------------------------------------------
  // Validation + activation
  // -------------------------------------------------------------------------

  /** Validate a set's persisted rows against R4/R5. Returns enumerable issues
   * (empty = activatable). */
  async validateSet(
    tenantId: string,
    connectionId: string,
    version: number,
  ): Promise<MappingValidationIssue[]> {
    await this.requireConnection(tenantId, connectionId);
    const set = await this.requireSet(tenantId, connectionId, version);
    const rows = await this.repo.rowsForSet(set.id);
    return this.validateRows(rows);
  }

  /** ATOMICALLY activate a DRAFT: validate → demote prior active → promote. */
  async activateSet(
    tenantId: string,
    connectionId: string,
    version: number,
    actorId: string,
  ): Promise<MappingSetDetailView> {
    await this.requireConnection(tenantId, connectionId);
    const set = await this.requireSet(tenantId, connectionId, version);
    this.requireDraft(set);

    const rows = await this.repo.rowsForSet(set.id);
    const issues = this.validateRows(rows);
    if (issues.length > 0) {
      throw new MappingAdminServiceError(
        'MAPPING_SET_INVALID',
        'mapping set failed validation and cannot be activated',
        issues,
      );
    }

    const priorActive = await this.repo.findActiveSet(tenantId, connectionId);
    try {
      const activated = await this.repo.activate({
        tenant_id: tenantId,
        connection_id: connectionId,
        draft_set_id: set.id,
        prior_active_id: priorActive?.id ?? null,
        activated_by: actorId,
      });
      this.audit?.emit(MAPPING_ADMIN_AUDIT_EVENTS.ACTIVATED, {
        tenant_id: tenantId,
        connection_id: connectionId,
        mapping_set_id: activated.id,
        version: activated.version,
        actor_id: actorId,
        supersedes_set_id: activated.supersedes_set_id,
      });
    } catch (err) {
      if (err instanceof ActiveSetConflictError) {
        throw new MappingAdminServiceError(
          'ACTIVE_SET_CONFLICT',
          'another active mapping set was activated concurrently; retry',
        );
      }
      throw err;
    }
    return this.getSet(tenantId, connectionId, version);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Normalize + validate authoring input into persistable rows. Rejects invalid
   * configurations at the service boundary (R4) — the DB CHECK is the backstop. */
  private prepareRows(rows: DraftMappingRowInput[]): PersistDraftRow[] {
    const prepared: PersistDraftRow[] = rows.map((r) => {
      const provider_state = normalizeProviderState(r.provider_state);
      if (r.disposition === MAPPING_DISPOSITION.IGNORE) {
        // Pass the action THROUGH (do not silently drop it) so validateRows below
        // REJECTS an IGNORE that carries an action (R4) — consistent with the DTO
        // and the DB CHECK. A valid IGNORE (no action) persists mapped_action null.
        return {
          provider_state,
          disposition: MAPPING_DISPOSITION.IGNORE,
          mapped_action: r.mapped_action ?? null,
        };
      }
      if (r.disposition === MAPPING_DISPOSITION.EXECUTE_ACTION) {
        const action = r.mapped_action ?? null;
        return {
          provider_state,
          disposition: MAPPING_DISPOSITION.EXECUTE_ACTION,
          mapped_action: action,
        };
      }
      // Unknown disposition — surface via validation with the row's provider_state.
      return {
        provider_state,
        disposition: String(r.disposition),
        mapped_action: r.mapped_action ?? null,
      };
    });
    const issues = this.validateRows(
      prepared.map((r) => ({
        id: '',
        provider_state: r.provider_state,
        disposition: r.disposition,
        mapped_action: r.mapped_action,
        authority_mode: MAPPING_ADMIN_AUTHORITY_MODE,
      })),
    );
    if (issues.length > 0) {
      throw new MappingAdminServiceError(
        'MAPPING_SET_INVALID',
        'mapping rows failed validation',
        issues,
      );
    }
    return prepared;
  }

  /** The shared R4/R5 legality check over rows. */
  private validateRows(rows: MappingRow[]): MappingValidationIssue[] {
    const issues: MappingValidationIssue[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.provider_state)) {
        issues.push({
          code: 'DUPLICATE_PROVIDER_STATE',
          provider_state: row.provider_state,
          detail: 'the same provider state is mapped more than once in this set',
        });
      }
      seen.add(row.provider_state);

      if (row.authority_mode !== MAPPING_ADMIN_AUTHORITY_MODE) {
        issues.push({
          code: 'UNSUPPORTED_AUTHORITY_MODE',
          provider_state: row.provider_state,
          detail: `only ${MAPPING_ADMIN_AUTHORITY_MODE} is authorable`,
        });
      }

      if (row.disposition === MAPPING_DISPOSITION.EXECUTE_ACTION) {
        if (row.mapped_action === null || !isMappingAdminAllowedAction(row.mapped_action)) {
          issues.push({
            code: 'EXECUTE_ACTION_REQUIRES_ALLOWED_ACTION',
            provider_state: row.provider_state,
            detail: 'EXECUTE_ACTION requires one of the four external actions',
          });
        }
      } else if (row.disposition === MAPPING_DISPOSITION.IGNORE) {
        if (row.mapped_action !== null) {
          issues.push({
            code: 'IGNORE_FORBIDS_ACTION',
            provider_state: row.provider_state,
            detail: 'IGNORE must not carry a mapped action',
          });
        }
      } else {
        issues.push({
          code: 'UNKNOWN_DISPOSITION',
          provider_state: row.provider_state,
          detail: `unknown disposition '${row.disposition}'`,
        });
      }
    }
    return issues;
  }

  private requireDraft(set: MappingSetRow): void {
    if (set.status !== MAPPING_SET_STATUS.DRAFT) {
      throw new MappingAdminServiceError(
        'MAPPING_SET_NOT_DRAFT',
        `mapping set version ${set.version} is ${set.status} and is immutable`,
      );
    }
  }

  private async requireConnection(tenantId: string, connectionId: string): Promise<void> {
    const row = await this.connections.findByIdForTenant(tenantId, connectionId);
    if (row === null) {
      throw new MappingAdminServiceError('CONNECTION_NOT_FOUND', 'connection not found for tenant');
    }
  }

  private async requireSet(
    tenantId: string,
    connectionId: string,
    version: number,
  ): Promise<MappingSetRow> {
    const set = await this.repo.findSetByVersion(tenantId, connectionId, version);
    if (set === null) {
      throw new MappingAdminServiceError('MAPPING_SET_NOT_FOUND', 'mapping set version not found');
    }
    return set;
  }

  private toSummary(set: MappingSetRow): MappingSetSummaryView {
    return {
      id: set.id,
      connection_id: set.connection_id,
      version: set.version,
      status: set.status,
      created_at: set.created_at.toISOString(),
      created_by: set.created_by,
      activated_at: set.activated_at === null ? null : set.activated_at.toISOString(),
      activated_by: set.activated_by,
      supersedes_set_id: set.supersedes_set_id,
    };
  }

  private toDetail(set: MappingSetRow, rows: MappingRow[]): MappingSetDetailView {
    return {
      ...this.toSummary(set),
      mappings: rows.map(
        (r): MappingRowView => ({
          id: r.id,
          provider_state: r.provider_state,
          disposition: r.disposition,
          mapped_action: r.mapped_action,
          authority_mode: r.authority_mode,
        }),
      ),
    };
  }
}
