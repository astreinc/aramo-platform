import { Injectable } from '@nestjs/common';

import {
  projectFullView,
  projectSummaryView,
} from './examination-full.projection.js';
import type {
  TalentJobExaminationFullView,
  TalentJobExaminationSummaryView,
} from './examination-full.types.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobExamination model (M3 PR-1 §3.3 + M3 PR-6 §4.2).
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

@Injectable()
export class ExaminationRepository {
  constructor(private readonly prisma: PrismaService) {}

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
