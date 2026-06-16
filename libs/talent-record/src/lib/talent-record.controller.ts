import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  ObjectStorageService,
  type PresignedPutResult,
} from '@aramo/object-storage';
import {
  ResumeParserService,
  type ParseResumeResult,
} from '@aramo/resume-parse';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import type { DraftFromResumeRequestDto } from './dto/draft-from-resume-request.dto.js';
import { LinkTalentRecordRequestDto } from './dto/link-talent-record-request.dto.js';
import type { ResumeUploadUrlRequestDto } from './dto/resume-upload-url-request.dto.js';
import type { TalentLinkView } from './dto/talent-link.view.js';
import type { TalentRecordView } from './dto/talent-record.view.js';
import type {
  TalentSearchPage,
  TalentSearchQuery,
  TalentSortKey,
} from './dto/talent-search.dto.js';
import type { UpdateTalentRecordRequestDto } from './dto/update-talent-record-request.dto.js';
import { TalentLinkService } from './talent-link.service.js';
import { TalentRecordRepository } from './talent-record.repository.js';

const SORT_KEYS: readonly TalentSortKey[] = [
  'name',
  'created_at',
  'owner',
  'location',
  'availability',
  'engagement',
  'hot',
];
function parseSort(value: string | undefined): TalentSortKey {
  return value !== undefined && (SORT_KEYS as readonly string[]).includes(value)
    ? (value as TalentSortKey)
    : 'created_at';
}
function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length > 0 ? parts : undefined;
}

// TalentRecordController — PR-A4 Gate 5 ATS Batch 3.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes('talent:<action>')   // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// Reuses the existing seeded `talent:*` scopes (read/create/edit/delete)
// per the directive amendment — the scope catalog is unchanged; the
// rename is at the lib + namespace + entity name level only.
//
// Recruiter divergence (Ruling 1): delete → `talent:delete` (tenant_admin
// only per the seeded catalog).
//
// NO assignment filter: TalentRecord is tenant + site scoped; visible to
// all entitled + scoped recruiters in the tenant. (Unlike requisition,
// which gates per-row by RequisitionAssignment.)
@Controller('v1/talent-records')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentRecordController {
  constructor(
    private readonly repo: TalentRecordRepository,
    private readonly linkService: TalentLinkService,
    private readonly objectStorage: ObjectStorageService,
    private readonly resumeParser: ResumeParserService,
  ) {}

  // Search PR-1/PR-2 — the LIST route gates on talent:read (route-static).
  //
  // Two OPTIONAL search params, both ADDITIONALLY requiring talent:search
  // (REUSED A1a "Constrained Talent Access" scope — D3, no new scope) WHEN
  // present; the no-search LIST keeps its talent:read-only gate (backward-
  // compat by construction):
  //   - ?q=         PR-1 name quick-search (ILIKE-contains, pg_trgm) — UNCHANGED.
  //   - ?resume_q=  PR-2 résumé content-search (websearch_to_tsquery over the
  //                 persisted+redacted résumé text; ts_rank-ordered; D2 snippets).
  //
  // Both NARROW within the existing tenant+site scope (talent is pool-open —
  // no per-record visibility resolver; the match never widens visibility).
  // Ruling R4 — when BOTH ?q= and ?resume_q= are present, the filters AND
  // (name-match AND résumé-match), ts_rank-ordered.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Query('q') q: string | undefined,
    @Query('resume_q') resumeQ: string | undefined,
    @Query('paged') paged: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('dir') dir: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('page_size') pageSize: string | undefined,
    @Query('availability') availability: string | undefined,
    @Query('engagement') engagement: string | undefined,
    @Query('source') source: string | undefined,
    @Query('hot') hot: string | undefined,
    @Query('owner') owner: string | undefined,
    @Query('skills') skills: string | undefined,
    @Query('skill_match') skillMatch: string | undefined,
    @Query('location') location: string | undefined,
    @Req()
    req: Request & {
      talentSearchQuery?: TalentSearchQuery;
      // Segment 4c — set by the apps/api TalentPresetInterceptor (PRE-handler):
      // a cross-schema preset's resolved talent-id allowlist, and the "My team"
      // scope's resolved owner-id set. Both are single-schema inputs here — the
      // lib never reads activity/pipeline/tasks/teams itself.
      talentPresetAllowlist?: readonly string[];
      talentScopeOwnerIds?: readonly string[];
    },
    @RequestId() requestId: string,
  ): Promise<{ items: TalentRecordView[] } | TalentSearchPage> {
    const searchTerm = q?.trim() ? q.trim() : undefined;
    const resumeTerm = resumeQ?.trim() ? resumeQ.trim() : undefined;
    if (
      (searchTerm !== undefined || resumeTerm !== undefined) &&
      !authContext.scopes.includes('talent:search')
    ) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'talent:search scope required for ?q= / ?resume_q= search',
        403,
        { requestId, details: { reason: 'search_scope_missing', required_scope: 'talent:search' } },
      );
    }

    // PR-2 résumé content-search path. Ruling R4 — pass the name term so the
    // repo ANDs the name filter when ?q= is also present.
    if (resumeTerm !== undefined) {
      const items = await this.repo.searchByResumeText({
        tenant_id: authContext.tenant_id,
        site_id: siteIdFromQuery,
        resume_q: resumeTerm,
        q: searchTerm,
      });
      return { items };
    }

    // Segment 4 — opt-in server-side faceted + keyset-paginated path. Returns
    // a superset ({ items, next_cursor, facets }) so the pre-Seg-4 FE (which
    // reads only `items`) keeps working unchanged.
    if (paged === 'true') {
      const query: TalentSearchQuery = {
        tenant_id: authContext.tenant_id,
        site_id: siteIdFromQuery,
        q: searchTerm,
        skills: splitCsv(skills),
        skill_match: skillMatch === 'all' ? 'all' : 'any',
        availability_status: splitCsv(availability),
        engagement_type: splitCsv(engagement),
        source: splitCsv(source),
        is_hot: hot === 'true' ? true : undefined,
        // Segment 4c — "My team" scope resolved upstream takes precedence over
        // the native owner param (the owner-is-me / all tabs use the param).
        owner_id: req.talentScopeOwnerIds ?? splitCsv(owner),
        location,
        // Segment 4c — a cross-schema preset's resolved allowlist (resolve-then-
        // filter). Empty array ⇒ preset matched nothing ⇒ zero results (distinct
        // from undefined = no preset). buildSearchWhere ANDs it with the natives.
        id_allowlist: req.talentPresetAllowlist,
        sort: parseSort(sort),
        dir: dir === 'asc' ? 'asc' : 'desc',
        cursor,
        page_size: pageSize !== undefined ? Number(pageSize) : undefined,
      };
      // Segment 4b — stash the parsed query on the request so the apps/api
      // enrichment interceptor (the only layer allowed to read activity /
      // consent / pipeline) can compute the full-set cross-schema facet counts.
      // The lib stays single-schema: it hands off a plain object, imports none
      // of the cross-schema modules.
      req.talentSearchQuery = query;
      return this.repo.searchPaged(query);
    }

    // PR-1 / no-search path — UNCHANGED (backward-compat by construction).
    const items = await this.repo.list({
      tenant_id: authContext.tenant_id,
      site_id: siteIdFromQuery,
      q: searchTerm,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    const view = await this.repo.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateTalentRecordRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    return this.repo.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      requestId,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateTalentRecordRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentRecordView> {
    return this.repo.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('talent:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.repo.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // PR-A5b-2 — Core-Talent link routes (the keystone).
  //
  // Scope reuse: the existing seeded `talent:read` / `talent:edit`
  // scopes cover the read / write surface naturally. A dedicated
  // `talent:link` scope was considered but not warranted — linking is
  // a per-record edit (the route shape and the data shape both fit
  // under `talent:edit`'s authority), and consolidating reduces the
  // scope-catalog churn at the keystone. If Gate 5 finds otherwise,
  // a dedicated scope can be added without rewriting the routes.
  //
  // SACRED BOUNDARIES (enforced by TalentLinkService):
  //   - LINK-NOT-CREATE — never mutates Core.
  //   - ASSOCIATE-NOT-RESOLVE — core_talent_id is an explicit input.
  // -------------------------------------------------------------------------

  @Get(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async getLink(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.getLink({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      requestId,
    });
  }

  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async link(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: LinkTalentRecordRequestDto,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.link({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      core_talent_id: body.core_talent_id,
      requestId,
    });
  }

  @Delete(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async unlink(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<TalentLinkView> {
    return this.linkService.unlink({
      tenant_id: authContext.tenant_id,
      talent_record_id: id,
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // A8-3b — résumé upload + parse-to-prefill (E1 + E2).
  //
  // Option A ordering (the Lead-ruled flow): parse-first, attach-on-create.
  // The recruiter:
  //   E1) POSTs /resume-upload-url -- the service returns a presigned PUT
  //       URL (the browser uploads bytes directly to S3; the API never
  //       hosts bytes). The PUT URL bakes `lifecycle=orphan-pending` into
  //       the signed payload so the S3 lifecycle Rule 5 sweeps abandoned
  //       uploads after 24h.
  //   E2) POSTs /draft-from-resume with the returned storage_key -- the
  //       service parses the S3 object deterministically (pdf-parse or
  //       mammoth; NO LLM per ADR-0015 Decision 10) and returns the
  //       prefill + parse_status. The recruiter reviews + edits.
  //   E3) POSTs /v1/talent-records (the existing create) with the final
  //       fields; client follows with POST /v1/attachments to bind the
  //       résumé. The Attachment.create path calls
  //       ObjectStorageService.markResumeCommitted to clear the orphan tag.
  //
  // Scope reuse (Gate 5 decision §2.3e): E1 uses attachment:create
  // (recruiter has it); E2 uses talent:read (read-shaped, returns a
  // talent-shape, no DB write). NO new `resume:parse` scope.
  // -------------------------------------------------------------------------

  @Post('resume-upload-url')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('attachment:create')
  @RequireSiteMatch()
  async createResumeUploadUrl(
    @AuthContext() authContext: AuthContextType,
    @Body() body: ResumeUploadUrlRequestDto,
    @RequestId() requestId: string,
  ): Promise<PresignedPutResult> {
    if (typeof body.filename !== 'string' || body.filename.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'filename must be a non-empty string',
        422,
        { requestId, details: { field: 'filename' } },
      );
    }
    if (typeof body.content_type !== 'string' || body.content_type.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'content_type must be a non-empty string',
        422,
        { requestId, details: { field: 'content_type' } },
      );
    }

    // Option A: the TalentRecord does not exist yet. Generate a draft
    // partition UUID to scope the S3 key; this UUID is internal --
    // the client receives only the opaque storage_key. The eventual
    // TalentRecord (created at E3) has its own id; the Attachment row
    // binds the storage_key (opaque) to the new TalentRecord id.
    const draft_partition_id = uuidv7();

    return this.objectStorage.createResumePresignedPut({
      tenant_id: authContext.tenant_id,
      talent_record_id: draft_partition_id,
      filename: body.filename,
      content_type: body.content_type,
      requestId,
    });
  }

  @Post('draft-from-resume')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async draftFromResume(
    @AuthContext() _authContext: AuthContextType,
    @Body() body: DraftFromResumeRequestDto,
    @RequestId() requestId: string,
  ): Promise<ParseResumeResult> {
    if (typeof body.storage_key !== 'string' || body.storage_key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'storage_key must be a non-empty string',
        422,
        { requestId, details: { field: 'storage_key' } },
      );
    }

    // The parser NEVER throws on parse failure -- it returns
    // { prefill: {}, parse_status: 'failed' }. The recruiter can still
    // proceed to E3 (manual create) -- parse-failure-is-non-blocking
    // (the proof §4.4 invariant).
    return this.resumeParser.parseFromStorageKey({
      storage_key: body.storage_key,
      requestId,
    });
  }
}
