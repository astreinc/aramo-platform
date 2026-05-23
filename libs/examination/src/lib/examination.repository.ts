import { Injectable } from '@nestjs/common';
import { JobDomainRepository } from '@aramo/job-domain';

import {
  projectFullView,
  projectSummaryView,
} from './examination-full.projection.js';
import type {
  TalentJobExaminationFullView,
  TalentJobExaminationSummaryView,
} from './examination-full.types.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobExamination model (M3 PR-1 §3.3 + M3 PR-6 §4.2
// + M3 PR-7 §4.1).
//
// Surface scope (closed):
//   - createSnapshot: insert a new immutable analytical snapshot.
//   - findById: read one snapshot.
//   - findByIdFull (PR-6): read-side projection — reads one snapshot and
//     types its opaque Json analytical columns into the structured
//     TalentJobExaminationFullView shape at the boundary. PROJECT-ONLY:
//     no query against libs/talent-evidence, no dereferencing of
//     EvidenceReference targets. READ-ONLY: issues no write, adds no
//     @relation, does not touch the immutability trigger.
//   - findByIdSummary (PR-6): companion projection for the
//     TalentJobExaminationSummaryView shape (Full's allOf base).
//   - findActiveReqLiveList (PR-7): the per-active-req Live List query —
//     loads the Requisition, verifies (state='active' AND tenant_id match),
//     selects ranked TalentJobExamination rows for the req's job_id with
//     lifecycle_state='active', and projects each through PR-6's
//     projectSummaryView. PULL-SIDE (Ruling 1), PROJECT-VIA-PR-6
//     (Ruling 3), READ-ONLY, NO ENGAGEMENT-STATE FILTER (Ruling 4 — that
//     filter is M5 territory).
//   - findByTenantAndTalent: read all snapshots for a (tenant, talent) pair,
//     newest first via the (tenant_id, talent_id, computed_at DESC, id DESC)
//     keyset index.
//   - markSuperseded: lifecycle-only write that sets
//     superseded_by_examination_id (and optionally lifecycle_state /
//     archived_at) on a prior snapshot. The database trigger
//     (talent_job_examination_no_analytical_update) blocks any analytical
//     field change; this method writes only the lifecycle columns the
//     §3.2 column-scoped trigger permits.
//
// Belt-and-suspenders immutability:
//   - No update method on analytical fields is exposed here.
//   - The database BEFORE UPDATE trigger rejects analytical-field UPDATEs
//     (see libs/examination/prisma/migrations/.../migration.sql).
//
// Version pinning (§3.3): examination_version / model_version /
// taxonomy_version are required at create time — a snapshot cannot be
// inserted unpinned. Enforcement is two-layer: the input type below
// makes them required (compile-time), and the columns are NOT NULL in
// the database (run-time).
//
// Application-layer validation: §2.4's "why_matched_sentence <= 140 chars"
// rule is enforced at the create-input boundary per directive §3.1.

const WHY_MATCHED_SENTENCE_MAX_CHARS = 140;

export type ExaminationTriggerValue =
  | 'initial_match'
  | 'talent_data_change'
  | 'job_data_change'
  | 'model_recompute'
  | 'taxonomy_recompute'
  | 'recruiter_requested'
  | 'scheduled_refresh';

export type ExaminationTierValue =
  | 'ENTRUSTABLE'
  | 'WORTH_CONSIDERING'
  | 'STRETCH';

export type ExaminationLifecycleStateValue =
  | 'active'
  | 'archived'
  | 'cold_storage';

// Json column input — Prisma's surface is `unknown` for Json reads; on
// writes we accept any JSON-serializable value. The nested-structure
// shapes (ExaminationReasoning, SkillMatchSummary, etc.) are defined in
// §2.4 and constructed by the matching engine in a later PR.
type JsonInput = unknown;

export interface CreateExaminationSnapshotInput {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  golden_profile_id: string;

  trigger: ExaminationTriggerValue;
  tier: ExaminationTierValue;
  rank_ordinal: number;

  why_matched_sentence: string;
  match_summary: string;

  expanded_reasoning: JsonInput;
  skill_match: JsonInput;
  experience_match: JsonInput;
  constraint_checks: JsonInput;
  strengths: JsonInput;
  gaps: JsonInput;
  risk_flags: JsonInput;
  confidence_indicators: JsonInput;
  freshness_indicator: JsonInput;
  delta_to_entrustable?: JsonInput | null;

  examination_version: string;
  model_version: string;
  taxonomy_version: string;

  computed_at: Date;
}

export interface TalentJobExaminationRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  golden_profile_id: string;
  trigger: ExaminationTriggerValue;
  tier: ExaminationTierValue;
  rank_ordinal: number;
  why_matched_sentence: string;
  match_summary: string;
  expanded_reasoning: unknown;
  skill_match: unknown;
  experience_match: unknown;
  constraint_checks: unknown;
  strengths: unknown;
  gaps: unknown;
  risk_flags: unknown;
  confidence_indicators: unknown;
  freshness_indicator: unknown;
  delta_to_entrustable: unknown;
  examination_version: string;
  model_version: string;
  taxonomy_version: string;
  computed_at: Date;
  lifecycle_state: ExaminationLifecycleStateValue;
  archived_at: Date | null;
  superseded_by_examination_id: string | null;
}

export interface MarkSupersededInput {
  // The snapshot being superseded.
  prior_id: string;
  // The id of the new snapshot that supersedes it.
  superseded_by_examination_id: string;
  // Optional lifecycle transition that may accompany supersession. The
  // database trigger permits writes to lifecycle_state, archived_at, and
  // superseded_by_examination_id; everything else is rejected.
  lifecycle_state?: ExaminationLifecycleStateValue;
  archived_at?: Date;
}

// M3 PR-7 §4.1 — Live List query input. Keyset pagination via an optional
// cursor on (tier, rank_ordinal, id); limit is clamped by the repository
// (default 50, hard cap 200) per Ruling 7.
export interface FindActiveReqLiveListInput {
  tenant_id: string;
  req_id: string;
  limit?: number;
  cursor?: {
    tier: ExaminationTierValue;
    rank_ordinal: number;
    id: string;
  };
}

// M3 PR-7 §2 Ruling 7 — limit clamp constants. Default applied when
// input.limit is omitted; hard cap applied to any explicitly-supplied
// value above it; floor applied to any value below 1.
const LIVE_LIST_DEFAULT_LIMIT = 50;
const LIVE_LIST_MAX_LIMIT = 200;
const LIVE_LIST_MIN_LIMIT = 1;

// Postgres compares enum values by their declared enum-position;
// ExaminationTier is declared as (ENTRUSTABLE, WORTH_CONSIDERING, STRETCH),
// so ASC means ENTRUSTABLE first, STRETCH last — what Live List wants.
// The (tenant_id, job_id, tier, rank_ordinal) index supports this
// traversal natively at the storage layer.
//
// Prisma 7's enum filter surface supports only `equals` / `in` / `not` /
// `notIn` — not `gt`. The keyset cursor's "tier > cursor.tier" branch is
// therefore expressed as an explicit `in` over the tiers that come strictly
// after `cursor.tier` in the declared order.
const TIERS_AFTER: Record<ExaminationTierValue, ExaminationTierValue[]> = {
  ENTRUSTABLE: ['WORTH_CONSIDERING', 'STRETCH'],
  WORTH_CONSIDERING: ['STRETCH'],
  STRETCH: [],
};

@Injectable()
export class ExaminationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobDomain: JobDomainRepository,
  ) {}

  async createSnapshot(
    input: CreateExaminationSnapshotInput,
  ): Promise<TalentJobExaminationRow> {
    if (input.why_matched_sentence.length > WHY_MATCHED_SENTENCE_MAX_CHARS) {
      throw new Error(
        `why_matched_sentence exceeds ${String(WHY_MATCHED_SENTENCE_MAX_CHARS)} characters (got ${String(input.why_matched_sentence.length)})`,
      );
    }
    const created = await this.prisma.talentJobExamination.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        job_id: input.job_id,
        golden_profile_id: input.golden_profile_id,
        trigger: input.trigger,
        tier: input.tier,
        rank_ordinal: input.rank_ordinal,
        why_matched_sentence: input.why_matched_sentence,
        match_summary: input.match_summary,
        expanded_reasoning: input.expanded_reasoning as never,
        skill_match: input.skill_match as never,
        experience_match: input.experience_match as never,
        constraint_checks: input.constraint_checks as never,
        strengths: input.strengths as never,
        gaps: input.gaps as never,
        risk_flags: input.risk_flags as never,
        confidence_indicators: input.confidence_indicators as never,
        freshness_indicator: input.freshness_indicator as never,
        delta_to_entrustable: (input.delta_to_entrustable ?? null) as never,
        examination_version: input.examination_version,
        model_version: input.model_version,
        taxonomy_version: input.taxonomy_version,
        computed_at: input.computed_at,
      },
    });
    return created as TalentJobExaminationRow;
  }

  async findById(id: string): Promise<TalentJobExaminationRow | null> {
    const row = await this.prisma.talentJobExamination.findUnique({
      where: { id },
    });
    return (row as TalentJobExaminationRow | null) ?? null;
  }

  // M3 PR-6 §4.2 — typed Summary read-projection. Reads the existing
  // TalentJobExamination row and types it into TalentJobExaminationSummaryView
  // (the API Contracts v1.0 Summary shape; the allOf base for Full).
  // READ-ONLY, PROJECT-ONLY (PR-6 §2 Ruling 2) — issues no write, queries no
  // other lib, does not dereference EvidenceReference targets.
  async findByIdSummary(id: string): Promise<TalentJobExaminationSummaryView | null> {
    const row = await this.findById(id);
    if (row === null) return null;
    return projectSummaryView(row);
  }

  // M3 PR-6 §4.2 — typed Full read-projection. Reads the existing
  // TalentJobExamination row and types its opaque Json analytical columns
  // into the structured TalentJobExaminationFullView shape at the boundary
  // (the API Contracts v1.0 Full shape; allOf Summary + the 5 additions per
  // L463-468). READ-ONLY, PROJECT-ONLY — no libs/talent-evidence query, no
  // dereferencing of EvidenceReference targets (PR-6 §2 Ruling 2). The
  // immutability trigger is untouched (no write).
  async findByIdFull(id: string): Promise<TalentJobExaminationFullView | null> {
    const row = await this.findById(id);
    if (row === null) return null;
    return projectFullView(row);
  }

  // M3 PR-7 §4.1 — Live List query per active req.
  //
  // PULL-SIDE (Ruling 1): an always-correct on-demand query; no materialized
  // state, no event subscription. PROJECT-VIA-PR-6 (Ruling 3): each selected
  // row is run through projectSummaryView so the canonical Summary
  // projection lives in exactly one place. READ-ONLY: no UPDATE/INSERT/
  // DELETE; the PR-1 immutability trigger is never reached.
  //
  // Behavior (directive §4.1):
  //   1. Load the Requisition by req_id via JobDomainRepository.
  //      findRequisitionById. Verify state='active' AND tenant_id matches.
  //      If absent / inactive / tenant-mismatched, return [] (NOT an
  //      exception — tenant mismatch is a security-posture recovery from a
  //      multi-tenant routing bug, not an error path).
  //   2. Apply Ruling 7 clamp: min(max(input.limit ?? 50, 1), 200).
  //   3. Query TalentJobExamination filtered by (tenant_id, job_id) with
  //      lifecycle_state='active'. Order (tier ASC, rank_ordinal ASC, id
  //      ASC). Apply limit and (if provided) the keyset cursor — the
  //      "next-page" predicate is (tier, rank_ordinal, id) > cursor in the
  //      query's ordering.
  //   4. Project each row through projectSummaryView (PR-6) and return.
  //
  // NO engagement-state filter (Ruling 4 — M5 territory, F20). NO
  // §14.4 sensitive-field mechanics (Ruling 6 — Summary-only output, no new
  // sensitive surfacing). NO HTTP endpoint (directive §5 — PR-8).
  async findActiveReqLiveList(
    input: FindActiveReqLiveListInput,
  ): Promise<TalentJobExaminationSummaryView[]> {
    // Step 1 — load and validate the Requisition.
    const requisition = await this.jobDomain.findRequisitionById(input.req_id);
    if (requisition === null) return [];
    if (requisition.state !== 'active') return [];
    if (requisition.tenant_id !== input.tenant_id) return [];

    // Step 2 — Ruling 7 clamp. Default 50 when omitted; floor 1; cap 200.
    const limit = Math.min(
      Math.max(input.limit ?? LIVE_LIST_DEFAULT_LIMIT, LIVE_LIST_MIN_LIMIT),
      LIVE_LIST_MAX_LIMIT,
    );

    // Step 3 — keyset cursor predicate (if provided). The query's ordering
    // is (tier ASC, rank_ordinal ASC, id ASC); the "next-page" predicate is
    // (tier, rank_ordinal, id) > (cursor.tier, cursor.rank_ordinal,
    // cursor.id). Expressed as the SQL-equivalent OR-chain so Prisma's
    // query planner can use the (tenant_id, job_id, tier, rank_ordinal)
    // index efficiently.
    //
    // Built as a plain object literal and cast at the findMany boundary via
    // `as never` (existing repository pattern, mirrors createSnapshot's
    // Json casts at L175-184): the Prisma client's generated
    // EnumExaminationTierFilter expects its own ExaminationTier enum type,
    // not the repository's ExaminationTierValue string-union type — the
    // values are byte-identical but TS treats the types as nominally
    // distinct.
    const baseWhere = {
      tenant_id: input.tenant_id,
      job_id: requisition.job_id,
      lifecycle_state: 'active',
    };
    const whereClause =
      input.cursor === undefined
        ? baseWhere
        : {
            ...baseWhere,
            OR: [
              // Branch 1: tier strictly after cursor.tier. Prisma 7 enum
              // filters don't support `gt`, so we materialise the explicit
              // list of subsequent tiers (TIERS_AFTER). When the cursor is
              // on the last tier (STRETCH), TIERS_AFTER is [] and this
              // branch contributes no rows — branches 2 and 3 still apply.
              { tier: { in: TIERS_AFTER[input.cursor.tier] } },
              // Branch 2: same tier, higher rank_ordinal. `gt` on Int is
              // supported.
              {
                AND: [
                  { tier: input.cursor.tier },
                  { rank_ordinal: { gt: input.cursor.rank_ordinal } },
                ],
              },
              // Branch 3: same tier and rank_ordinal, lexically-later id
              // (the tiebreaker for stable pagination). `gt` on String/Uuid
              // is supported.
              {
                AND: [
                  { tier: input.cursor.tier },
                  { rank_ordinal: input.cursor.rank_ordinal },
                  { id: { gt: input.cursor.id } },
                ],
              },
            ],
          };

    // Step 4 — query the ranked rows (tenant + req filter; active only).
    const rows = await this.prisma.talentJobExamination.findMany({
      where: whereClause as never,
      orderBy: [
        { tier: 'asc' },
        { rank_ordinal: 'asc' },
        { id: 'asc' },
      ],
      take: limit,
    });

    // Step 5 — project each row through PR-6's projectSummaryView. Single
    // canonical Summary-producing path (Ruling 3); no duplicated logic.
    return (rows as TalentJobExaminationRow[]).map((r) => projectSummaryView(r));
  }

  async findByTenantAndTalent(
    tenant_id: string,
    talent_id: string,
  ): Promise<TalentJobExaminationRow[]> {
    const rows = await this.prisma.talentJobExamination.findMany({
      where: { tenant_id, talent_id },
      orderBy: [{ computed_at: 'desc' }, { id: 'desc' }],
    });
    return rows as TalentJobExaminationRow[];
  }

  // M4 PR-4 §4.1 — newest-active-snapshot lookup per (tenant, talent, job).
  // Returns the single most recent ACTIVE examination row for the triple
  // (ordered by computed_at DESC, id DESC tiebreaker), or null if none.
  // Lifecycle-filtered (active only): archived / cold_storage rows are
  // skipped so the submittal-confirm caller's "is the pin still the
  // latest?" check honors the same lifecycle posture used everywhere else
  // (PR-2 buildPackage refuses non-active examinations; PR-7
  // findActiveReqLiveList filters active; etc.).
  //
  // READ-ONLY, single-snapshot: issues no write, no projection — callers
  // compare the returned row's id against the pinned id directly.
  async findLatestByTenantTalentJob(input: {
    tenant_id: string;
    talent_id: string;
    job_id: string;
  }): Promise<TalentJobExaminationRow | null> {
    const row = await this.prisma.talentJobExamination.findFirst({
      where: {
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        job_id: input.job_id,
        lifecycle_state: 'active',
      },
      orderBy: [{ computed_at: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : (row as TalentJobExaminationRow);
  }

  async markSuperseded(
    input: MarkSupersededInput,
  ): Promise<TalentJobExaminationRow> {
    const updated = await this.prisma.talentJobExamination.update({
      where: { id: input.prior_id },
      data: {
        superseded_by_examination_id: input.superseded_by_examination_id,
        ...(input.lifecycle_state !== undefined
          ? { lifecycle_state: input.lifecycle_state }
          : {}),
        ...(input.archived_at !== undefined
          ? { archived_at: input.archived_at }
          : {}),
      },
    });
    return updated as TalentJobExaminationRow;
  }
}
