import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { JobDomainRepository } from '@aramo/job-domain';

import { ExaminationRepository, type ExaminationTierValue } from './examination.repository.js';
import type { TalentJobExaminationSummaryView } from './examination-full.types.js';

// M3 PR-8 Match-List Controller — GET /v1/jobs/{job_id}/matches.
//
// Returns the ranked TalentJobExaminationSummary[] Live List for the named
// active requisition. Summary-only per API Contracts L586-588: MUST NEVER
// return TalentJobExaminationFull. The endpoint enforces this by
// construction — findActiveReqLiveList projects through projectSummaryView,
// which only emits Summary fields.
//
// Auth posture: class-level JwtAuthGuard, plus per-route consumer_type
// === 'recruiter' assertion inside the handler (directive Ruling 6).
// Non-recruiter consumers (portal, ingestion) are 403'd at the route, not
// just authenticated. Pre-existing spec/code drift around consumer_type
// (API Contracts ATS/PORTAL/INGESTION/INTERNAL vs substrate code
// 'recruiter'/'portal'/'ingestion') is acknowledged in the directive and
// NOT reconciled here.
//
// Empty-list-on-no-active-requisition (directive §4.1 step 5): when no
// matching active Requisition exists for (tenant_id, job_id), the
// endpoint returns 200 with an empty data[] envelope (NOT 404). Mirrors
// PR-7's findActiveReqLiveList security posture — tenant mismatch is a
// recovery from a multi-tenant routing bug, not an error path.
//
// Cursor encoding (directive §4.1 step 4): base64+JSON wrapping of the
// keyset triplet { tier, rank_ordinal, id } PR-7's findActiveReqLiveList
// accepts. Opaque to consumers (API Contracts L57).
//
// No service layer (directive Ruling 2): repositories are injected
// directly. The controller has no orchestration — extract params,
// resolve requisition, query Live List, wrap, return.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TIERS: ReadonlySet<ExaminationTierValue> = new Set([
  'ENTRUSTABLE',
  'WORTH_CONSIDERING',
  'STRETCH',
]);

interface CursorPayload {
  tier: ExaminationTierValue;
  rank_ordinal: number;
  id: string;
}

interface PaginationEnvelope {
  cursor: string | null;
  next_cursor: string | null;
  page_size: number;
  has_more: boolean;
}

interface MatchListResponseDto {
  data: TalentJobExaminationSummaryView[];
  pagination: PaginationEnvelope;
}

@Controller('v1/jobs')
@UseGuards(JwtAuthGuard)
export class MatchListController {
  constructor(
    private readonly examinationRepository: ExaminationRepository,
    private readonly jobDomainRepository: JobDomainRepository,
  ) {}

  @Get(':job_id/matches')
  @HttpCode(HttpStatus.OK)
  async listMatches(
    @Param('job_id') job_id: string,
    @Query('limit') limitRaw: string | undefined,
    @Query('cursor') cursorRaw: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MatchListResponseDto> {
    // Step 1 — auth check (Ruling 6). Per-route consumer_type assertion.
    this.assertConsumerIsRecruiter(authContext, requestId);

    // Step 2 — UUID validation.
    this.assertJobIdFormat(job_id, requestId);

    // Step 3 — limit parsing. Pass through to repository for the [1,200]
    // clamp; the controller only rejects bad input shapes.
    const limit = this.parseLimit(limitRaw, requestId);

    // Step 4 — cursor decoding (base64+JSON of { tier, rank_ordinal, id }).
    const cursor = this.parseCursor(cursorRaw, requestId);

    // Step 5 — resolve the active Requisition for (tenant_id, job_id).
    const requisition = await this.jobDomainRepository.findActiveRequisitionByJobId({
      tenant_id: authContext.tenant_id,
      job_id,
    });
    if (requisition === null) {
      // Empty-list response (not 404) — directive §4.1 step 5 + step 7.
      return {
        data: [],
        pagination: {
          cursor: cursorRaw ?? null,
          next_cursor: null,
          page_size: 0,
          has_more: false,
        },
      };
    }

    // Step 6 — list query against PR-7's findActiveReqLiveList. The
    // repository internally clamps limit [1,200], default 50.
    const rows = await this.examinationRepository.findActiveReqLiveList({
      tenant_id: authContext.tenant_id,
      req_id: requisition.id,
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    // Step 7 — response envelope.
    // Effective limit: when the caller omits limit, the repository default
    // (50) is what determines has_more. We mirror the repository's clamp
    // here so has_more reflects the actual page boundary.
    const effectiveLimit = limit === undefined ? 50 : Math.min(Math.max(limit, 1), 200);
    const hasMore = rows.length === effectiveLimit;
    const nextCursor = hasMore ? this.encodeCursor(rows[rows.length - 1]!) : null;

    // Step 8 — return.
    return {
      data: rows,
      pagination: {
        cursor: cursorRaw ?? null,
        next_cursor: nextCursor,
        page_size: rows.length,
        has_more: hasMore,
      },
    };
  }

  private assertConsumerIsRecruiter(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'match-list endpoint is recruiter-only',
        403,
        {
          requestId,
          details: { consumer_type: authContext.consumer_type },
        },
      );
    }
  }

  private assertJobIdFormat(job_id: string, requestId: string): void {
    if (!UUID_REGEX.test(job_id)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'job_id must be a UUID',
        400,
        { requestId, details: { invalid_field: 'job_id' } },
      );
    }
  }

  private parseLimit(limitRaw: string | undefined, requestId: string): number | undefined {
    if (limitRaw === undefined || limitRaw === '') return undefined;
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'limit must be a positive integer',
        400,
        { requestId, details: { invalid_field: 'limit' } },
      );
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (parsed < 1) {
      throw new AramoError(
        'INVALID_REQUEST',
        'limit must be at least 1',
        400,
        { requestId, details: { invalid_field: 'limit' } },
      );
    }
    return parsed;
  }

  private parseCursor(
    cursorRaw: string | undefined,
    requestId: string,
  ): CursorPayload | undefined {
    if (cursorRaw === undefined || cursorRaw === '') return undefined;
    let decoded: string;
    try {
      decoded = Buffer.from(cursorRaw, 'base64').toString('utf8');
    } catch {
      throw this.badCursorError(requestId);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw this.badCursorError(requestId);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('tier' in parsed) ||
      !('rank_ordinal' in parsed) ||
      !('id' in parsed)
    ) {
      throw this.badCursorError(requestId);
    }
    const obj = parsed as { tier: unknown; rank_ordinal: unknown; id: unknown };
    if (typeof obj.tier !== 'string' || !VALID_TIERS.has(obj.tier as ExaminationTierValue)) {
      throw this.badCursorError(requestId);
    }
    if (typeof obj.rank_ordinal !== 'number' || !Number.isInteger(obj.rank_ordinal) || obj.rank_ordinal < 0) {
      throw this.badCursorError(requestId);
    }
    if (typeof obj.id !== 'string' || !UUID_REGEX.test(obj.id)) {
      throw this.badCursorError(requestId);
    }
    return {
      tier: obj.tier as ExaminationTierValue,
      rank_ordinal: obj.rank_ordinal,
      id: obj.id,
    };
  }

  private badCursorError(requestId: string): AramoError {
    return new AramoError(
      'INVALID_REQUEST',
      'cursor is malformed',
      400,
      { requestId, details: { invalid_field: 'cursor' } },
    );
  }

  private encodeCursor(row: TalentJobExaminationSummaryView): string {
    const payload: CursorPayload = {
      tier: row.tier,
      rank_ordinal: row.rank_ordinal,
      id: row.examination_id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }
}
