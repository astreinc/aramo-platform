import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
  ImportBatchView,
  ImportFailureView,
} from './dto/import-batch.view.js';
import { isImportTargetEntity } from './dto/import-target-entity.js';
import type { RunImportRequestDto } from './dto/run-import-request.dto.js';
import type { SuggestMappingRequestDto } from './dto/suggest-mapping-request.dto.js';
import type { SuggestMappingResponseDto } from './dto/suggest-mapping-response.dto.js';
import { ImportService } from './import.service.js';
import { MappingSuggestionService } from './mapping/mapping-suggestion.service.js';

// ImportController — PR-A8-1 Gate 5 (the import ENGINE).
//
// Guard chain (the A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope keys (NOT seeded — gap-and-note per directive §4) ===
//
// `import:create`, `import:read`, `import:delete` are referenced but
// NOT in the SEED_SCOPE_KEYS catalog at PR-A8-1. A future
// HK-IMPORT-SCOPES bundle seeds them (mirrors the HK-IDENT-SCOPES /
// HK-SAVED-LIST-SCOPES precedent). At PR-A8-1 any caller's JWT must
// already carry these scopes for the routes to pass RolesGuard; the
// bare scopes-not-in-catalog state is a gap-and-note, not a breaking
// refusal.
//
// === Scope tiering — when the HK-IMPORT-SCOPES bundle seeds these ===
//
// (recorded here so the seed bundle assigns the tiers correctly)
//
//   - `import:create` → recruiter+ (creating an import is an
//     operational act — the recruiter loads the CSV).
//   - `import:read`   → recruiter+ (every recruiter can audit imports
//     in their tenant; the audit log is not sensitive).
//   - `import:delete` → **tenant_admin ONLY** (the Lead-reviewed
//     Commit-Plan §2 OVERRIDE). A batch-revert is a BULK ENTITY DELETE
//     — it removes every row a batch created (potentially hundreds of
//     real entity rows) atomically. That is mass entity destruction,
//     which Ruling 1 guards squarely + at scale. It is categorically
//     UNLIKE the HK-IDENT-SCOPES `attachment:delete` carve-out (which
//     was a *junction/link* delete, explicitly NOT entity destruction).
//     A recruiter accidentally reverting the wrong batch could wipe
//     hundreds of real records — exactly the data-loss Ruling 1
//     prevents. The "natural reverter" instinct from Gate 5 does NOT
//     outweigh it: a recruiter may *request* a revert, but the bulk-
//     destructive act requires tenant_admin authority. The
//     `import:delete` tiering matches `requisition:delete` /
//     `pipeline:remove` / every entity `:delete` in the existing
//     catalog.
@Controller('v1/imports')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly mappingSuggestion: MappingSuggestionService,
  ) {}

  // -------------------------------------------------------------------------
  // Read surface.
  // -------------------------------------------------------------------------

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('import:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: ImportBatchView[] }> {
    const items = await this.importService.list({
      tenant_id: authContext.tenant_id,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('import:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ImportBatchView> {
    const view = await this.importService.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'ImportBatch not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Get(':id/failures')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('import:read')
  @RequireSiteMatch()
  async getFailures(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<{ items: ImportFailureView[] }> {
    const items = await this.importService.listFailures({
      tenant_id: authContext.tenant_id,
      import_batch_id: id,
      requestId,
    });
    return { items };
  }

  // -------------------------------------------------------------------------
  // Write surface — the engine's main entry point.
  // -------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('import:create')
  @RequireSiteMatch()
  async run(
    @AuthContext() authContext: AuthContextType,
    @Body() body: RunImportRequestDto,
    @RequestId() requestId: string,
  ): Promise<ImportBatchView> {
    // Shape-only validation at the boundary — class-validator is not
    // wired here (the body is structurally a thin DTO). The 4-way
    // target_entity check is the load-bearing closed-list gate.
    if (!isImportTargetEntity(body.target_entity)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `invalid target_entity: ${String(body.target_entity)}`,
        400,
        {
          requestId,
          details: { target_entity: body.target_entity },
        },
      );
    }
    if (!Array.isArray(body.rows)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'rows must be an array',
        400,
        { requestId },
      );
    }
    if (typeof body.mapping !== 'object' || body.mapping === null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'mapping must be a column→field object',
        400,
        { requestId },
      );
    }
    if (
      typeof body.source_filename !== 'string' ||
      body.source_filename.length === 0
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'source_filename is required',
        400,
        { requestId },
      );
    }

    return this.importService.runImport({
      tenant_id: authContext.tenant_id,
      imported_by_id: authContext.sub,
      input: body,
      // D-AUTHZ-COMP-WRITE-1 — thread the initiating actor's scopes
      // through to per-target createForImport gates (ruling 3).
      scopes: authContext.scopes,
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // PR-A8-2 — AI-assisted column-mapping (deterministic heuristic).
  //
  // POST /v1/imports/suggest-mapping returns a SuggestedMapping the
  // user reviews/corrects before confirming into POST /v1/imports.
  // SUGGEST-not-auto-apply: A8-2 NEVER runs an import on its own
  // suggestion (the suggest [A8-2] → user confirms → import [A8-1]
  // flow).
  //
  // Same scope as POST /v1/imports (`import:create`) — a pre-import
  // step under the same authority. The class-level guard chain
  // (JwtAuthGuard / EntitlementGuard / RolesGuard +
  // @RequireCapability('ats')) gates entitlement + tenant axes; the
  // route-level @RequireScopes + @RequireSiteMatch gate scope + site.
  // The same A2 three-axis pattern as every other ImportController
  // route.
  //
  // ADR-0015 boundary: this route's handler delegates to
  // MappingSuggestionService — a DETERMINISTIC heuristic. NO LLM
  // call, NO ai-draft import, NO external network. The
  // no-llm-boundary spec asserts this structurally.
  @Post('suggest-mapping')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('import:create')
  @RequireSiteMatch()
  async suggestMapping(
    @AuthContext() _authContext: AuthContextType,
    @Body() body: SuggestMappingRequestDto,
    @RequestId() requestId: string,
  ): Promise<SuggestMappingResponseDto> {
    if (!isImportTargetEntity(body.target_entity)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `invalid target_entity: ${String(body.target_entity)}`,
        400,
        { requestId, details: { target_entity: body.target_entity } },
      );
    }
    if (!Array.isArray(body.headers) || body.headers.some((h) => typeof h !== 'string')) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'headers must be a string[]',
        400,
        { requestId },
      );
    }
    if (!Array.isArray(body.sample_rows)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'sample_rows must be an array of row objects',
        400,
        { requestId },
      );
    }
    return this.mappingSuggestion.suggest({
      target_entity: body.target_entity,
      headers: body.headers,
      sample_rows: body.sample_rows,
    });
  }

  @Post(':id/revert')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('import:delete')
  @RequireSiteMatch()
  async revert(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ImportBatchView> {
    return this.importService.revert({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }
}
