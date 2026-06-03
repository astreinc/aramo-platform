import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

import type {
  ConfirmedMapping,
  ImportRow,
  RunImportRequestDto,
} from './dto/run-import-request.dto.js';
import type {
  ImportBatchView,
  ImportFailureView,
} from './dto/import-batch.view.js';
import type {
  ImportBatchStatus,
  ImportTargetEntity,
} from './dto/import-target-entity.js';
import {
  loadImportEngineConfig,
  thresholdExceeded,
  type ImportEngineConfig,
} from './import-config.js';
import { PrismaService } from './prisma/prisma.service.js';

// ImportService — the import ENGINE (PR-A8-1 Gate 5).
//
// === Boundaries ===
//
// THE non-negotiable boundary (directive §0): importing target_entity =
// 'talent_record' creates `talent_record.TalentRecord` rows with
// `core_talent_id` NULL. The engine NEVER calls Core Talent's
// createTalent / createOverlay — canonicalization is M6-owned (T2).
// Structural proof: this service imports ONLY @aramo/company,
// @aramo/contact, @aramo/requisition, @aramo/talent-record. It does
// NOT import @aramo/talent (the Core lib). The integration spec proves
// the boundary by `talent.*` bit-identical row-counts pre/post (the
// A5b-2 boundary-proof pattern, replayed at the import layer).
//
// === Partial-commit semantics ([GATE-5 PREMISE] — Lead reviews) ===
//
// Per-row commit, NOT all-or-nothing. Each successful row is inserted
// in its own write (via the target lib's createForImport). At the end
// of the row loop:
//   - failure_count == 0                   → status = 'committed'
//   - 0 < failure_count <= threshold_limit → status = 'partially_committed'
//                                            (the successful rows persist)
//   - failure_count > threshold_limit       → REJECT: call the target's
//                                              deleteByImportBatch to remove
//                                              this batch's already-inserted
//                                              rows; status = 'rejected'.
//
// The Lead review question (directive §3): is partial-commit "every
// valid row stands forever even if a later row fails" (per-row
// committed-as-we-go) or "all valid rows in one tx, all-or-none on
// transaction commit"? This implementation is the former — per-row
// committed-as-we-go — because:
//   1. The failed-rows artifact (GET /failures) is designed for
//      fix-and-reimport: the failed rows are recorded with their
//      original data; the recruiter fixes them in the source CSV and
//      re-imports JUST those rows. If partial-commit were all-valid-in-
//      one-tx, the partial-commit case would still leave the recruiter
//      re-uploading the entire file, defeating the artifact's purpose.
//   2. For very large CSVs (10k+ rows) a single $transaction is
//      operationally heavy — long-lived transactions hold locks and
//      bloat WAL. Per-row commit scales linearly.
//   3. The rejection path (failures-above-threshold) IS atomic: the
//      engine deletes the batch's already-inserted rows by the
//      import_batch_id back-reference (which the per-row commit
//      reliably attributes). This is the "all-or-nothing-when-too-bad"
//      net.
//
// === Threshold config ([GATE-5 PREMISE] — Lead reviews) ===
//
// Env-driven defaults (loadImportEngineConfig in import-config.ts):
// IMPORT_FAILURE_THRESHOLD_PCT (default 10%) + IMPORT_REVERT_WINDOW_DAYS
// (default 7). A future PR can lift this to a `tenant_settings` row
// without changing the engine's surface. The directive §0 explicitly
// REFUSES OpenCATS's hard-coded `100` threshold.

interface ImportBatchRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  imported_by_id: string;
  target_entity: ImportTargetEntity;
  source_filename: string;
  row_count: number;
  success_count: number;
  failure_count: number;
  status: ImportBatchStatus;
  created_at: Date;
  committed_at: Date | null;
  reverted_at: Date | null;
}

interface ImportFailureRow {
  id: string;
  tenant_id: string;
  import_batch_id: string;
  row_number: number;
  failure_reason: string;
  offending_fields: unknown;
  original_row_data: unknown;
  created_at: Date;
}

function projectBatchView(row: ImportBatchRow): ImportBatchView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    imported_by_id: row.imported_by_id,
    target_entity: row.target_entity,
    source_filename: row.source_filename,
    row_count: row.row_count,
    success_count: row.success_count,
    failure_count: row.failure_count,
    status: row.status,
    created_at: row.created_at.toISOString(),
    committed_at: row.committed_at === null ? null : row.committed_at.toISOString(),
    reverted_at: row.reverted_at === null ? null : row.reverted_at.toISOString(),
  };
}

function projectFailureView(row: ImportFailureRow): ImportFailureView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    import_batch_id: row.import_batch_id,
    row_number: row.row_number,
    failure_reason: row.failure_reason,
    offending_fields: Array.isArray(row.offending_fields)
      ? (row.offending_fields as string[])
      : [],
    original_row_data:
      typeof row.original_row_data === 'object' && row.original_row_data !== null
        ? (row.original_row_data as Record<string, unknown>)
        : {},
    created_at: row.created_at.toISOString(),
  };
}

// The per-target REQUIRED-field set (used for the row-level validation
// step). A row missing any of these fields fails before the create is
// attempted — keeping the @aramo/<target>'s create surface trusted to
// throw only on cross-schema-validator failures.
const REQUIRED_FIELDS: Record<ImportTargetEntity, readonly string[]> = {
  company: ['name'],
  contact: ['first_name', 'last_name', 'company_id'],
  requisition: ['title', 'company_id'],
  talent_record: ['first_name', 'last_name'],
};

// Apply the confirmed mapping to a raw row, returning the entity DTO
// shape. Unknown source columns are silently dropped (the mapping is
// authoritative — only mapped columns survive).
function applyMapping(
  row: ImportRow,
  mapping: ConfirmedMapping,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [csvColumn, entityField] of Object.entries(mapping)) {
    if (csvColumn in row) {
      out[entityField] = row[csvColumn];
    }
  }
  return out;
}

// Return the list of REQUIRED fields that are absent / empty in the
// mapped row. Empty-string is treated as absent for required text
// fields (so `"first_name": ""` fails).
function findMissingRequired(
  mappedRow: Record<string, unknown>,
  target: ImportTargetEntity,
): string[] {
  const required = REQUIRED_FIELDS[target];
  const missing: string[] = [];
  for (const field of required) {
    const v = mappedRow[field];
    if (v === undefined || v === null || v === '') {
      missing.push(field);
    }
  }
  return missing;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly config: ImportEngineConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyRepository: CompanyRepository,
    private readonly contactRepository: ContactRepository,
    private readonly requisitionRepository: RequisitionRepository,
    private readonly talentRecordRepository: TalentRecordRepository,
  ) {
    this.config = loadImportEngineConfig();
    this.logger.log(
      `ImportService configured: failure_threshold_pct=${this.config.failure_threshold_pct}, revert_window_days=${this.config.revert_window_days}`,
    );
  }

  // -------------------------------------------------------------------------
  // The engine's main entry point.
  // -------------------------------------------------------------------------

  async runImport(args: {
    tenant_id: string;
    imported_by_id: string;
    input: RunImportRequestDto;
    requestId: string;
  }): Promise<ImportBatchView> {
    const { tenant_id, imported_by_id, input } = args;

    // 1. Create the batch (status: 'pending').
    const batch = (await this.prisma.importBatch.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        imported_by_id,
        target_entity: input.target_entity,
        source_filename: input.source_filename,
        row_count: input.rows.length,
        success_count: 0,
        failure_count: 0,
        status: 'pending',
      },
    })) as ImportBatchRow;

    // 2. Per-row apply mapping → validate → insert (or record failure).
    let success_count = 0;
    const failures: Array<{
      row_number: number;
      failure_reason: string;
      offending_fields: string[];
      original_row_data: ImportRow;
    }> = [];

    for (let i = 0; i < input.rows.length; i++) {
      const rowIndex = i + 1; // 1-based for the recruiter's UX.
      const rawRow = input.rows[i];
      if (rawRow === undefined) continue;
      const mapped = applyMapping(rawRow, input.mapping);

      // Required-field gate (cheap, runs first).
      const missing = findMissingRequired(mapped, input.target_entity);
      if (missing.length > 0) {
        failures.push({
          row_number: rowIndex,
          failure_reason: `missing required field(s): ${missing.join(', ')}`,
          offending_fields: missing,
          original_row_data: rawRow,
        });
        continue;
      }

      // Per-target insert. Failures from the target repo (NOT_FOUND on
      // cross-schema validator, etc.) are caught + recorded.
      try {
        await this.insertOneRow({
          target: input.target_entity,
          tenant_id,
          imported_by_id,
          import_batch_id: batch.id,
          mapped,
          requestId: args.requestId,
        });
        success_count++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // AramoError preserves details (e.g. company_id not found in
        // tenant); other errors get a generic reason. We do NOT
        // re-throw — per-row failures don't poison the whole batch.
        failures.push({
          row_number: rowIndex,
          failure_reason: message,
          offending_fields: [],
          original_row_data: rawRow,
        });
      }
    }

    const failure_count = failures.length;

    // 3. Persist the per-row failure rows (one INSERT each — kept
    // simple; volume is bounded by the threshold check that follows).
    // Prisma JSON columns accept InputJsonValue; we coerce via the
    // structured-clone boundary so the typed Record / typed array maps
    // cleanly without leaking `unknown` into the engine's surface.
    for (const f of failures) {
      await this.prisma.importFailure.create({
        data: {
          tenant_id,
          import_batch_id: batch.id,
          row_number: f.row_number,
          failure_reason: f.failure_reason,
          offending_fields: f.offending_fields as unknown as object,
          original_row_data: f.original_row_data as unknown as object,
        },
      });
    }

    // 4. Decide outcome.
    const exceeded = thresholdExceeded(
      input.rows.length,
      failure_count,
      this.config.failure_threshold_pct,
    );

    if (exceeded) {
      // Above threshold — REJECT the whole batch. Delete the rows we
      // already inserted (the per-row commits) by the back-reference.
      await this.deleteRowsForBatch({
        tenant_id,
        target: input.target_entity,
        batch_id: batch.id,
      });

      const updated = (await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          row_count: input.rows.length,
          success_count: 0, // rolled back
          failure_count,
          status: 'rejected',
          committed_at: new Date(),
        },
      })) as ImportBatchRow;

      // 422 IMPORT_THRESHOLD_EXCEEDED with the audit context. The
      // batch itself + its failures remain queryable by id (the
      // audit lives forever); the recruiter inspects them via GET
      // /v1/imports/:id/failures, fixes, re-imports.
      throw new AramoError(
        'IMPORT_THRESHOLD_EXCEEDED',
        'Import rejected: failure count exceeded the configured threshold',
        422,
        {
          requestId: args.requestId,
          details: {
            import_batch_id: updated.id,
            row_count: updated.row_count,
            failure_count: updated.failure_count,
            threshold_pct: this.config.failure_threshold_pct,
          },
        },
      );
    }

    // Below or at threshold — commit.
    const final_status: ImportBatchStatus =
      failure_count === 0 ? 'committed' : 'partially_committed';

    const finalRow = (await this.prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        row_count: input.rows.length,
        success_count,
        failure_count,
        status: final_status,
        committed_at: new Date(),
      },
    })) as ImportBatchRow;

    return projectBatchView(finalRow);
  }

  // Per-target insert dispatch. The 4-way switch is exhaustive over
  // ImportTargetEntity; TypeScript checks completeness via the
  // discriminated-union narrowing.
  private async insertOneRow(args: {
    target: ImportTargetEntity;
    tenant_id: string;
    imported_by_id: string;
    import_batch_id: string;
    mapped: Record<string, unknown>;
    requestId: string;
  }): Promise<void> {
    const base = {
      tenant_id: args.tenant_id,
      entered_by_id: args.imported_by_id,
      import_batch_id: args.import_batch_id,
    };
    switch (args.target) {
      case 'company':
        await this.companyRepository.createForImport({
          ...base,
          // The DTO is a structural subset of args.mapped; the target
          // repo's createForImport accepts a CreateCompanyRequestDto.
          // Casting at the boundary keeps the engine's types narrow
          // without coupling libs/import to every per-target DTO shape.
          input: args.mapped as never,
        });
        return;
      case 'contact':
        await this.contactRepository.createForImport({
          ...base,
          input: args.mapped as never,
          requestId: args.requestId,
        });
        return;
      case 'requisition':
        await this.requisitionRepository.createForImport({
          ...base,
          input: args.mapped as never,
        });
        return;
      case 'talent_record':
        await this.talentRecordRepository.createForImport({
          ...base,
          // THE non-negotiable boundary. createForImport sets
          // core_talent_id NULL unconditionally — the engine never
          // crosses into Core.
          input: args.mapped as never,
        });
        return;
    }
  }

  // Tenant-scoped target-row deletion by the batch back-reference. The
  // 4-way switch dispatches to the per-target deleteByImportBatch. Used
  // by both the threshold-reject path (rolling back per-row commits)
  // and the explicit revert route.
  private async deleteRowsForBatch(args: {
    tenant_id: string;
    target: ImportTargetEntity;
    batch_id: string;
  }): Promise<number> {
    const refs = {
      tenant_id: args.tenant_id,
      import_batch_id: args.batch_id,
    };
    switch (args.target) {
      case 'company':
        return this.companyRepository.deleteByImportBatch(refs);
      case 'contact':
        return this.contactRepository.deleteByImportBatch(refs);
      case 'requisition':
        return this.requisitionRepository.deleteByImportBatch(refs);
      case 'talent_record':
        return this.talentRecordRepository.deleteByImportBatch(refs);
    }
  }

  // -------------------------------------------------------------------------
  // Audit + read surface.
  // -------------------------------------------------------------------------

  async list(args: {
    tenant_id: string;
    site_id?: string;
    limit?: number;
  }): Promise<ImportBatchView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = (await this.prisma.importBatch.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    })) as ImportBatchRow[];
    return rows.map(projectBatchView);
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ImportBatchView | null> {
    const row = (await this.prisma.importBatch.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    })) as ImportBatchRow | null;
    return row === null ? null : projectBatchView(row);
  }

  async listFailures(args: {
    tenant_id: string;
    import_batch_id: string;
    requestId: string;
  }): Promise<ImportFailureView[]> {
    // Confirm the batch is in tenant (so a cross-tenant id returns the
    // canonical NOT_FOUND, NOT an empty list — info-leak closing).
    const batch = await this.findById({
      tenant_id: args.tenant_id,
      id: args.import_batch_id,
    });
    if (batch === null) {
      throw new AramoError(
        'NOT_FOUND',
        'ImportBatch not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.import_batch_id },
        },
      );
    }
    const rows = (await this.prisma.importFailure.findMany({
      where: {
        tenant_id: args.tenant_id,
        import_batch_id: args.import_batch_id,
      },
      orderBy: { row_number: 'asc' },
    })) as ImportFailureRow[];
    return rows.map(projectFailureView);
  }

  // -------------------------------------------------------------------------
  // Reversion (the audited-batch reversal — directive §3).
  // -------------------------------------------------------------------------

  async revert(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<ImportBatchView> {
    const row = (await this.prisma.importBatch.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    })) as ImportBatchRow | null;
    if (row === null) {
      throw new AramoError(
        'NOT_FOUND',
        'ImportBatch not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    // Terminal-state guard (the SUBMITTAL_ALREADY_CONFIRMED 409
    // precedent). A rejected batch's rows were already rolled back; a
    // reverted batch's rows are already gone. Either way the request
    // is a no-op rejection.
    if (row.status === 'reverted' || row.status === 'rejected') {
      throw new AramoError(
        'IMPORT_ALREADY_REVERTED',
        `ImportBatch is in terminal state '${row.status}' — cannot revert`,
        409,
        {
          requestId: args.requestId,
          details: { id: args.id, status: row.status },
        },
      );
    }

    // Pending batches shouldn't be revert-able through this surface
    // (the run is in-flight). In practice the run-loop is synchronous
    // so a pending status leaking here would be a coding bug; we still
    // reject to be safe.
    if (row.status === 'pending') {
      throw new AramoError(
        'IMPORT_ALREADY_REVERTED',
        'ImportBatch is still pending — cannot revert',
        409,
        {
          requestId: args.requestId,
          details: { id: args.id, status: row.status },
        },
      );
    }

    // Revert-window check.
    const now = new Date();
    const ageMs = now.getTime() - row.created_at.getTime();
    const windowMs = this.config.revert_window_days * 24 * 60 * 60 * 1000;
    if (ageMs > windowMs) {
      throw new AramoError(
        'IMPORT_REVERT_WINDOW_EXPIRED',
        `ImportBatch is older than the configured ${this.config.revert_window_days}-day revert window`,
        409,
        {
          requestId: args.requestId,
          details: {
            id: args.id,
            created_at: row.created_at.toISOString(),
            window_days: this.config.revert_window_days,
          },
        },
      );
    }

    // Delete the batch's target rows (tenant-scoped deleteMany).
    const deleted = await this.deleteRowsForBatch({
      tenant_id: args.tenant_id,
      target: row.target_entity,
      batch_id: row.id,
    });

    // Mark the batch reverted. We preserve row_count / failure_count
    // for the audit; success_count goes to 0 (the rows are gone).
    const updated = (await this.prisma.importBatch.update({
      where: { id: row.id },
      data: {
        status: 'reverted',
        success_count: 0,
        reverted_at: new Date(),
      },
    })) as ImportBatchRow;

    this.logger.log(
      `Reverted import batch ${row.id}: deleted ${deleted} ${row.target_entity} rows in tenant ${args.tenant_id}`,
    );

    return projectBatchView(updated);
  }
}
