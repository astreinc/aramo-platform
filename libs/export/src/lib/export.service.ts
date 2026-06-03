import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

import { stringifyCsv } from './csv-stringifier.js';
import {
  getDefaultColumns,
  resolveColumns,
  type ExportEntityType,
} from './field-catalog.js';

// PR-A8-4 — the export engine.
//
// === The TWO load-bearing guards (the Lead-review surface) ===
//
// (1) R10 — structural. The export ENGINE reads ONLY the 5 ATS-domain
//     repositories (Company / Contact / Requisition / TalentRecord /
//     Pipeline). The ATS-domain schemas structurally hold NO Core-
//     judgment field (the R10-forbidden set is defined authoritatively
//     in scripts/verify-vocabulary.sh + ci/scripts/verify-ats-refusal.ts;
//     the Gate-5 §1 check confirmed the ATS schemas carry none of it).
//     Therefore an export CAN'T leak any of those (there is nothing
//     in the read surface to leak). The lint:nx-boundaries graph for
//     libs/export contains ZERO Core / engagement / submittal /
//     examination / talent / job_domain edges — the structural proof;
//     the
//     integration spec replays the A7 reporting-service pattern by
//     OMITTING every Core migration from the test container and
//     asserting the export routes still serve 200 (if any Core read
//     existed it would 500 with "relation does not exist").
//
// (2) A3-visibility. Per Ruling 2 (A3), visibility is a QUERY
//     PREDICATE, not a guard rejection. Both `requisition:read`
//     (recruiter) and `requisition:read:all` (tenant_admin) pass
//     @RequireScopes — the rows they SEE differ:
//       - tenant_admin → tenant-wide rows.
//       - recruiter   → only requisitions assigned to AuthContext.sub
//                       (via RequisitionRepository.listForActor, which
//                       applies the assignments.some.user_id = sub
//                       predicate); only pipelines on those visible
//                       requisitions (composed at THIS service layer
//                       by resolving visibleReqIds first, then
//                       constraining pipeline reads via the upstream-
//                       resolved id list — the A7 reporting pattern).
//     Reference-entity exports (company / contact / talent_record)
//     are tenant-wide for BOTH roles, matching the A7 precedent that
//     A3 visibility applies to the recruiter-assignment domain only
//     (requisition + pipeline), NOT to the reference-data surface.
//     Export is NOT a visibility-bypass — a recruiter exports
//     EXACTLY what they could read in the UI, no more.
//
// === Export speaks Talent (outbound vocabulary) ===
//
// The header row uses the canonical Aramo ATS field names verbatim
// (first_name, last_name, email1, ...). The inbound-vocabulary
// aliases live in libs/import (the spreadsheet-migration carve-out)
// and DO NOT appear here. The integration spec asserts the
// talent_record export header row contains the canonical field
// names and zero outbound-anti-tokens (see the spec's
// OUTBOUND_ANTI_TOKENS list).

interface ActorContext {
  tenant_id: string;
  user_id: string;
  scopes: readonly string[];
  site_id?: string;
}

const REQUISITION_READ_ALL = 'requisition:read:all';

// The pipeline.requisition_ids filter is composed from the actor's
// A3-visible requisition set. The A7 visibility-ceiling cap (200)
// is the same number used by ReportingService.resolveVisibleRequisition
// Ids — beyond that, the recruiter export will undersample; the
// expected ATS scale is well below this in the recruiter-per-user
// per-tenant model.
const A3_VISIBILITY_CEILING = 200;

// Default per-call row cap (the "single-shot export" envelope; a
// streaming bulk-export endpoint is a separate later batch). The hard
// max is enforced at the controller via the catalog cap below.
const DEFAULT_ROW_LIMIT = 5000;
const MAX_ROW_LIMIT = 10_000;

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly companyRepository: CompanyRepository,
    private readonly contactRepository: ContactRepository,
    private readonly requisitionRepository: RequisitionRepository,
    private readonly talentRecordRepository: TalentRecordRepository,
    private readonly pipelineRepository: PipelineRepository,
  ) {}

  /**
   * Export the requested entity_type as a CSV string. The service
   * applies the R10 boundary (only ATS reads) + the A3-visibility
   * predicate (requisition / pipeline) + the column-selection
   * (validated upstream at the controller).
   *
   * Returns the CSV body as a string. The controller is responsible
   * for the response headers (Content-Type: text/csv;
   * Content-Disposition: attachment).
   */
  async exportEntity(args: {
    entity_type: ExportEntityType;
    columns?: readonly string[];
    limit?: number;
    actor: ActorContext;
    requestId: string;
  }): Promise<string> {
    const resolvedColumns = resolveColumns(args.entity_type, args.columns);
    if (resolvedColumns === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Unknown column requested for entity_type=${args.entity_type}`,
        400,
        {
          requestId: args.requestId,
          details: {
            entity_type: args.entity_type,
            requested_columns: args.columns ?? [],
            allowed_columns: getDefaultColumns(args.entity_type),
          },
        },
      );
    }

    const limit = Math.min(args.limit ?? DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
    const rows = await this.readRows({
      entity_type: args.entity_type,
      limit,
      actor: args.actor,
    });

    return stringifyCsv({ columns: resolvedColumns, rows });
  }

  // -------------------------------------------------------------------------
  // Per-entity read paths (every read is ATS-only — R10 structural).
  // -------------------------------------------------------------------------

  private async readRows(args: {
    entity_type: ExportEntityType;
    limit: number;
    actor: ActorContext;
  }): Promise<ReadonlyArray<Record<string, unknown>>> {
    const baseArgs = {
      tenant_id: args.actor.tenant_id,
      ...(args.actor.site_id === undefined
        ? {}
        : { site_id: args.actor.site_id }),
      limit: args.limit,
    };

    // The View DTOs are typed structural interfaces (no index
    // signature); the stringifier reads cells through a string key, so
    // we coerce to a record-shaped projection here. Each View is a
    // closed property bag — the coercion is sound because the catalog
    // column names are themselves keys of the View interface.
    switch (args.entity_type) {
      case 'company':
        // Reference data — tenant-wide for both roles (A7 precedent).
        return asRecords(await this.companyRepository.list(baseArgs));

      case 'contact':
        return asRecords(await this.contactRepository.list(baseArgs));

      case 'talent_record':
        return asRecords(await this.talentRecordRepository.list(baseArgs));

      case 'requisition':
        // A3-visibility predicate is APPLIED inside listForActor —
        // recruiter sees only assigned reqs; tenant_admin sees all.
        return asRecords(
          await this.requisitionRepository.listForActor({
            tenant_id: args.actor.tenant_id,
            actor_scopes: args.actor.scopes,
            actor_user_id: args.actor.user_id,
            ...(args.actor.site_id === undefined
              ? {}
              : { site_id: args.actor.site_id }),
            limit: args.limit,
          }),
        );

      case 'pipeline': {
        // A3-visibility composition (the A7 reporting pattern):
        // pipeline.requisition_id is a cross-schema logical UUID, so
        // Prisma cannot traverse the assignment join in-query. The
        // visible requisition_ids are resolved upstream from
        // RequisitionRepository, then passed as the `requisition_ids`
        // filter to PipelineRepository.list. Tenant_admin gets the
        // unrestricted set (visibleReqIds = undefined).
        const visibleReqIds = await this.resolveVisibleRequisitionIds(
          args.actor,
        );
        return asRecords(
          await this.pipelineRepository.list({
            tenant_id: args.actor.tenant_id,
            ...(visibleReqIds === undefined
              ? {}
              : { requisition_ids: visibleReqIds }),
            limit: args.limit,
          }),
        );
      }
    }
  }

  /**
   * Resolves the set of requisition_ids visible to the actor.
   *
   *   - tenant_admin (`requisition:read:all` ∈ scopes) → undefined,
   *     signaling "no filter, tenant-wide".
   *   - recruiter (only `requisition:read`) → an explicit list of the
   *     requisition_ids assigned to AuthContext.sub. The pipeline
   *     read constrains `requisition_id IN (...)` against this list.
   *
   * Returning undefined for the see-all branch is load-bearing — the
   * pipeline repo treats undefined as "no requisition_ids constraint",
   * matching the tenant_admin tenant-wide semantics.
   */
  private async resolveVisibleRequisitionIds(
    actor: ActorContext,
  ): Promise<readonly string[] | undefined> {
    if (actor.scopes.includes(REQUISITION_READ_ALL)) return undefined;
    const reqs = await this.requisitionRepository.listForActor({
      tenant_id: actor.tenant_id,
      actor_scopes: actor.scopes,
      actor_user_id: actor.user_id,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      limit: A3_VISIBILITY_CEILING,
    });
    return reqs.map((r) => r.id);
  }
}

// View → Record coercion. The entity Views are structural interfaces
// without an explicit index signature; the CSV stringifier reads each
// row through `row[column]`. The View IS a property bag at runtime,
// so the cast is a pure type-level relaxation — no value is changed.
function asRecords<T extends object>(
  rows: readonly T[],
): ReadonlyArray<Record<string, unknown>> {
  return rows as ReadonlyArray<Record<string, unknown>>;
}
