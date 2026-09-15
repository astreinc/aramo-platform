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
  buildResumeSourceMap,
  extractContact,
  type ParseResumeResult,
  type ParseStatus,
  type TalentRecordPrefill,
} from '@aramo/resume-parse';
import { TenantSettingService } from '@aramo/settings';
import {
  TalentExtractionService,
  type ResumeDraftStatus,
  type TalentWorkHistoryView,
} from '@aramo/talent-extraction';

import type { CreateTalentRecordRequestDto } from './dto/create-talent-record-request.dto.js';
import type { DraftFromResumeRequestDto } from './dto/draft-from-resume-request.dto.js';
import type { DraftFromResumeResponse } from './dto/draft-from-resume.response.js';
import type { TalentDuplicateCheckResponse } from './dto/talent-duplicate-check.view.js';
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
    // Add-Talent governed-LLM résumé extraction (LOCKED). Consumed ONLY by the
    // draft-from-resume handler; the mode resolver + the governed extractor.
    private readonly tenantSetting: TenantSettingService,
    private readonly talentExtraction: TalentExtractionService,
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

  // Proactive duplicate check for the Add-Talent flow. Declared BEFORE
  // @Get(':id') so the literal segment isn't captured as an id param. NO
  // @RequireSiteMatch(): primary-email uniqueness is tenant-wide (mirrors the
  // create-time 409, which also queries tenant-wide), so a collision in any
  // site must surface here. `talent:read` — the same pool-open read scope the
  // list + detail use; the projection exposes nothing the list doesn't.
  @Get('duplicate-check')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async duplicateCheck(
    @AuthContext() authContext: AuthContextType,
    @Query('email') email: string | undefined,
  ): Promise<TalentDuplicateCheckResponse> {
    const trimmed = (email ?? '').trim();
    if (trimmed === '') return { match: null };
    const match = await this.repo.findDuplicateByEmail({
      tenant_id: authContext.tenant_id,
      email: trimmed,
    });
    return { match };
  }

  // Talent-detail work-history (LOCKED scope expansion — "display what we
  // created"). Returns the persisted declared work-history for the talent
  // (source='resume', verified:false). talent:read + site-match, like the
  // detail read. Delegated to the already-injected TalentExtractionService.
  @Get(':id/work-history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async workHistory(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
  ): Promise<{ work_history: TalentWorkHistoryView[] }> {
    const work_history = await this.talentExtraction.listDeclaredWorkHistory({
      talent_id: id,
      tenant_id: authContext.tenant_id,
    });
    return { work_history };
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
    // B3/B4 — the MANUAL create path requires a primary email + cell phone (the
    // identity/dedup anchors) and refuses a duplicate primary email. This gate
    // lives on the HTTP handler, so the promotion/sourcing path (which calls
    // repo.create directly with tenant_status='sourced') is unaffected. No DB
    // NOT-NULL constraint — server + FE validation only (PO ruling).
    const email1 = (body.email1 ?? '').trim();
    const phoneCell = (body.phone_cell ?? '').trim();
    if (email1 === '' || phoneCell === '') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'A primary email and a cell phone are required to create a talent.',
        422,
        {
          requestId,
          details: {
            email1: email1 === '' ? 'required' : undefined,
            phone_cell: phoneCell === '' ? 'required' : undefined,
          },
        },
      );
    }
    const duplicate = await this.repo.findActiveByEmail({
      tenant_id: authContext.tenant_id,
      email: email1,
    });
    if (duplicate !== null) {
      throw new AramoError(
        'TALENT_RECORD_DUPLICATE',
        'A talent with this primary email already exists in your tenant.',
        409,
        { requestId, details: { email1, existing_id: duplicate.id } },
      );
    }
    const created = await this.repo.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      requestId,
    });

    // HF1 Gate-6 confirmed-create provenance sequence (deterministic; NO AI call
    // — Ruling 3). Order per the ruling flow: record → (résumé TalentDocument) →
    // work-history evidence + skill evidence, each stamped with durable
    // provenance (source_document_id + source_refs + source_map_version +
    // resume_text_hash). BEST-EFFORT: the talent IS created; a provenance/evidence
    // write hiccup must not fail the create (mirrors the attach-on-create
    // soft-fail). Reuses the already-injected TalentExtractionService (no new edge).
    try {
      // R1 — create/link the résumé TalentDocument ONLY here, after confirmed
      // creation (never at draft/proposal time). Its id anchors the evidence.
      let sourceDocumentId: string | undefined;
      const rd = body.resume_document;
      if (rd !== undefined && typeof rd.storage_key === 'string' && rd.storage_key !== '') {
        sourceDocumentId = await this.talentExtraction.createResumeDocument({
          talent_id: created.id,
          tenant_id: authContext.tenant_id,
          uploaded_by_actor_id: authContext.sub,
          storage_key: rd.storage_key,
          filename: rd.file_name,
          mime_type: rd.mime_type,
          size_bytes: rd.size_bytes,
        });
      }
      const provenance = {
        ...(sourceDocumentId !== undefined ? { source_document_id: sourceDocumentId } : {}),
        ...(rd?.source_map_version !== undefined
          ? { source_map_version: rd.source_map_version }
          : {}),
        ...(rd?.resume_text_hash !== undefined ? { resume_text_hash: rd.resume_text_hash } : {}),
      };

      if (Array.isArray(body.work_history) && body.work_history.length > 0) {
        await this.talentExtraction.persistDeclaredWorkHistory({
          talent_id: created.id,
          tenant_id: authContext.tenant_id,
          entries: body.work_history,
          provenance,
        });
      }
      // R2 — persist résumé skills as declared evidence WITH provenance (the
      // key_skills scalar is retained by repo.create above — this is additive).
      if (Array.isArray(body.skills) && body.skills.length > 0) {
        await this.talentExtraction.persistDeclaredSkills({
          talent_id: created.id,
          tenant_id: authContext.tenant_id,
          skills: body.skills,
          provenance,
        });
      }
      // HF2 R8/R18/R19 — persist reviewed education + certifications as declared
      // evidence WITH provenance (additive; DECLARED, not verified).
      if (Array.isArray(body.education) && body.education.length > 0) {
        await this.talentExtraction.persistDeclaredEducation({
          talent_id: created.id,
          tenant_id: authContext.tenant_id,
          education: body.education,
          provenance,
        });
      }
      if (Array.isArray(body.certifications) && body.certifications.length > 0) {
        await this.talentExtraction.persistDeclaredCertifications({
          talent_id: created.id,
          tenant_id: authContext.tenant_id,
          certifications: body.certifications,
          provenance,
        });
      }
    } catch {
      // Non-fatal: the record is created; the recruiter can add evidence on the
      // Talent record. (No PII in logs — §17.)
    }

    return created;
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
    // Contact-anchor edit gate (Talent Admission Invariant + data-correction).
    // email1/phone_cell are identity/dedup anchors — mandatory at create and, by
    // default, immutable afterward. Editing them for DATA CORRECTION is authorized
    // ONLY for tenant_admin + tenant_owner via the dedicated `talent:edit:contact`
    // scope (never a role-name check); `talent:edit` alone (recruiter+) must not.
    // Editable ≠ nullable: a correction may not blank an anchor (would violate the
    // admission invariant, which the update() repo path does not itself re-assert).
    if (body.email1 !== undefined || body.phone_cell !== undefined) {
      if (!authContext.scopes.includes('talent:edit:contact')) {
        throw new AramoError(
          'INSUFFICIENT_PERMISSIONS',
          'editing a talent contact anchor (email/phone) requires talent:edit:contact (tenant_admin/tenant_owner)',
          403,
          {
            requestId,
            details: { required_scope: 'talent:edit:contact' },
          },
        );
      }
    }
    if (body.email1 !== undefined && (body.email1 === null || body.email1.trim() === '')) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'email1 is a required contact anchor and cannot be cleared',
        400,
        { requestId, details: { field: 'email1' } },
      );
    }
    if (
      body.phone_cell !== undefined &&
      (body.phone_cell === null || body.phone_cell.trim() === '')
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'phone_cell is a required contact anchor and cannot be cleared',
        400,
        { requestId, details: { field: 'phone_cell' } },
      );
    }

    // Scalar PATCH first (the repo allowlist-walk ignores work_history — it is
    // not a TalentRecord column). The returned view is the record's scalar shape.
    const updated = await this.repo.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
    });

    // Full-profile EDIT (LOCKED scope expansion): when the edit carries a
    // work_history array, REPLACE the talent's declared work-history with the
    // reviewed set (replace-set — the reviewed set BECOMES the record's declared
    // work history; an empty array clears it). ABSENT work_history = scalar-only
    // PATCH (e.g. the quick-edit drawer) → work-history untouched. Unlike the
    // create path's best-effort persist, an edit failure PROPAGATES: the recruiter
    // explicitly edited these rows and must see a failure, not a silent loss.
    if (Array.isArray(body.work_history)) {
      await this.talentExtraction.replaceDeclaredWorkHistory({
        talent_id: id,
        tenant_id: authContext.tenant_id,
        entries: body.work_history,
      });
    }

    return updated;
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
  // PR-A5b-2 — cluster-link routes (the keystone).
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
  //   - LINK-NOT-CREATE — never mints an identity.
  //   - ASSOCIATE-NOT-RESOLVE — cluster_id is an explicit input.
  // 4e-rest: the link is now CLUSTER-ONLY (the PERSON_CLUSTER pointer); the
  // former identity-link column was dropped.
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
      cluster_id: body.cluster_id,
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
    @AuthContext() authContext: AuthContextType,
    @Body() body: DraftFromResumeRequestDto,
    @RequestId() requestId: string,
  ): Promise<DraftFromResumeResponse> {
    if (typeof body.storage_key !== 'string' || body.storage_key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'storage_key must be a non-empty string',
        422,
        { requestId, details: { field: 'storage_key' } },
      );
    }

    // MODE IS EXCLUSIVE (LOCKED). The tenant setting selects the SOLE résumé
    // extractor SERVER-side (§14 — never trust the FE). Unknown/absent → the
    // setting's default ('deterministic'); the LLM is never silently enabled.
    const mode = await this.tenantSetting.get(
      authContext.tenant_id,
      'resume.extraction_mode',
    );

    if (mode === 'governed_llm') {
      return this.draftGovernedLlm(body.storage_key, authContext.tenant_id, requestId);
    }

    // deterministic — the existing parser ONLY; NO LLM call. Parse failure is
    // non-blocking: returns { prefill: {}, parse_status: 'failed' } (proof §4.4).
    const result: ParseResumeResult = await this.resumeParser.parseFromStorageKey({
      storage_key: body.storage_key,
      requestId,
    });
    return {
      mode: 'deterministic',
      prefill: result.prefill,
      parse_status: result.parse_status,
    };
  }

  // Governed-LLM draft (MODE IS EXCLUSIVE): the governed LLM is the ONLY
  // extractor — the deterministic parser does NOT contribute values. HF1: build
  // the Aramo-owned source-map here (resume-parse owns text→blocks, R1) and pass
  // it BY VALUE into talent-extraction, which returns an EXPLICIT status (§13/R9).
  // A technical failure (truncation / off-schema / provider error) surfaces as a
  // distinct warning — NEVER a silent fallback to the deterministic parser (§15),
  // and NEVER a masked "successful extraction with zero facts".
  private async draftGovernedLlm(
    storage_key: string,
    tenant_id: string,
    requestId: string,
  ): Promise<DraftFromResumeResponse> {
    const RETRY_WARNING =
      'We couldn’t read this résumé. Please retry, or enter the details manually.';

    let text: string | null;
    try {
      text = await this.resumeParser.extractTextFromStorageKey({ storage_key, requestId });
    } catch {
      // Fetch/extract error — non-blocking; empty prefill + retry.
      return { mode: 'governed_llm', prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
    }
    if (text === null || text.trim() === '') {
      return { mode: 'governed_llm', prefill: {}, parse_status: 'failed', warning: RETRY_WARNING };
    }

    // HF1 §3/R1 — the canonical source-map (version + text hash + ordered blocks),
    // built by the bytes→text owner and handed by value to the grounding lib.
    const source_map = buildResumeSourceMap(text);

    let result;
    try {
      result = await this.talentExtraction.extractResumeDraft({ tenant_id, source_map });
    } catch {
      // Defensive: the structured path maps provider errors to a status and does
      // not throw, but an unexpected throw still degrades to a retry affordance.
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'partial',
        extraction_status: 'provider_failure',
        warning:
          'Résumé extraction is temporarily unavailable. Please retry, or enter the details manually.',
      };
    }

    const { status, proposal } = result;

    // Explicit technical-failure states (§13/R9): distinct, honest warnings —
    // never a masked empty draft. No prefill is offered on a technical failure.
    if (status === 'provider_truncated') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning:
          'This résumé was too long to read in a single pass. Please retry, or enter the details manually.',
      };
    }
    if (status === 'invalid_structured_output') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'failed',
        extraction_status: status,
        warning: RETRY_WARNING,
      };
    }
    if (status === 'provider_failure') {
      return {
        mode: 'governed_llm',
        prefill: {},
        parse_status: 'partial',
        extraction_status: status,
        warning:
          'Résumé extraction is temporarily unavailable. Please retry, or enter the details manually.',
      };
    }

    // HF2 R17 — LOCAL, deterministic contact + location extraction over the RAW
    // résumé text. This is the authorized hybrid path: contact/location is local
    // (email/phone never derive from — nor reach — the model; the model input was
    // separately PII-redacted at the provider boundary in extractResumeDraft),
    // while Talent Intelligence stays governed-LLM. city/state/ZIP are local-first
    // (never hostage to whether the model returns a location), with the model's
    // grounded location only a fallback for whatever local missed.
    const contact = extractContact(text);

    // success | partial — map the grounded proposal onto the recruiter-facing
    // prefill. Email/phone come ONLY from the local extractor (they are redacted
    // before the model — ADR-0015 Decision-6 / §17), never from the proposal.
    const prefill: TalentRecordPrefill = {};
    if (proposal.first_name !== undefined) prefill.first_name = proposal.first_name;
    if (proposal.last_name !== undefined) prefill.last_name = proposal.last_name;
    if (proposal.address !== undefined) prefill.address = proposal.address;
    if (proposal.country !== undefined) prefill.country = proposal.country;
    // Local contact (email/phone) — deterministic, LLM never saw these.
    if (contact.email1 !== undefined) prefill.email1 = contact.email1;
    if (contact.email2 !== undefined) prefill.email2 = contact.email2;
    if (contact.phone_cell !== undefined) prefill.phone_cell = contact.phone_cell;
    if (contact.phone_home !== undefined) prefill.phone_home = contact.phone_home;
    if (contact.phone_work !== undefined) prefill.phone_work = contact.phone_work;
    // Location — local-first, model-grounded as fallback (R17: not model-only).
    const city = contact.city ?? proposal.city;
    if (city !== undefined) prefill.city = city;
    const state = contact.state ?? proposal.state;
    if (state !== undefined) prefill.state = state;
    const zip = contact.zip ?? proposal.zip;
    if (zip !== undefined) prefill.zip = zip;
    if (proposal.current_employer !== undefined) prefill.current_employer = proposal.current_employer;
    if (proposal.title !== undefined) prefill.title = proposal.title;
    // Clean skills → the free-text key_skills field (the recruiter-facing R5 §2
    // surface). The STRUCTURED skills + their source_refs are carried separately
    // (below) for durable provenance (R7).
    if (proposal.skills.length > 0) {
      prefill.key_skills = proposal.skills.map((s) => s.surface_form).join(', ');
    }

    const hasIdentity = prefill.first_name !== undefined || prefill.last_name !== undefined;
    const hasAny = Object.keys(prefill).length > 0 || proposal.work_history.length > 0;
    const parse_status: ParseStatus = hasIdentity ? 'parsed' : 'partial';
    return {
      mode: 'governed_llm',
      prefill,
      parse_status,
      extraction_status: status,
      // Reviewable work-history (declared 'from résumé', recruiter-editable),
      // each carrying its source_refs (§16/R8).
      ...(proposal.work_history.length > 0 ? { work_history: proposal.work_history } : {}),
      // R7 — structured skills + source_refs carried through the API (the FE form
      // uses the free-text key_skills; these preserve durable skill provenance).
      ...(proposal.skills.length > 0 ? { skills: proposal.skills } : {}),
      // HF2 R8/R18/R19 — grounded education + certifications carried to the review
      // card (declared 'from résumé'; persisted with provenance on create).
      ...(proposal.education.length > 0 ? { education: proposal.education } : {}),
      ...(proposal.certifications.length > 0 ? { certifications: proposal.certifications } : {}),
      // §16 — provenance anchors the FE carries back into the create request.
      source_map_version: proposal.source_map_version,
      resume_text_hash: proposal.resume_text_hash,
      ...(hasAny
        ? {}
        : { warning: 'No details could be read from this résumé. Please enter them manually.' }),
    };
  }
}
