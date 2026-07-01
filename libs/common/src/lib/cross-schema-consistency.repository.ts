import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

// M5 PR-11 §4.4 — cross-schema consistency repository.
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding.
// ADR-0018 Decision 7 codifies the critical-pair scope: 5 pairs covered
// at PR-11; other pairs (evidence, talent_evidence ↔ skills_taxonomy,
// tenant references, submittal references) deferred to M6/M7.
//
// Critical pairs (per audit Axis E Lead-Q-E1=(b) disposition):
//   1. consent."TalentConsentEvent".talent_id ↔ talent."Talent".id
//   2. engagement."TalentJobEngagement".talent_id ↔ talent_record."TalentRecord".id
//      (4e-engagement-key — was talent."Talent".id before the re-point)
//   3. examination."TalentJobExamination".talent_id ↔ talent."Talent".id
//   4. examination."TalentJobExamination".job_id ↔ job_domain."Job".id
//   5. examination."TalentJobExamination".golden_profile_id
//      ↔ job_domain."GoldenProfile".id
//
// Cross-schema references in the platform are UUID-only (Architecture
// §7.3); no FK constraints can detect orphans, so this scanner is the
// reconciliation pathway.
//
// Implementation uses `pg` directly (vs. a per-module Prisma client)
// because (a) no single Prisma client owns 5 schemas, (b) cross-schema
// queries via fully-qualified table names are straightforward in raw
// SQL, and (c) the scanner is read-only and aggregates orphan counts
// without producing typed domain rows. ADR-0018 Decision 7.
//
// Lazy validation per F11/F14 lesson (mirrors libs/matching's
// RedisConnectionConfig + libs/consent's PrismaService): constructor
// does NOT read process.env. First call to a query method resolves the
// connection URL, throws "DATABASE_URL is not configured" if absent,
// builds the Pool, and memoizes.

export interface OrphanedReferenceSample {
  pair_id: string;
  // Owning row id (e.g., consent.TalentConsentEvent.id) — the row that
  // points at the missing foreign-side row.
  row_id: string;
  // The foreign-side id value that has no matching row in the target table.
  missing_foreign_id: string;
}

export interface CrossSchemaPairResult {
  pair_id: string;
  orphan_count: number;
  // Up to `sample_size` orphaned rows for forensic inspection. Empty when
  // the count is zero.
  samples: OrphanedReferenceSample[];
}

const PAIRS = [
  {
    pair_id: 'consent.TalentConsentEvent.talent_id->talent.Talent',
    sql:
      'SELECT cte.id AS row_id, cte.talent_id AS missing_foreign_id ' +
      'FROM "consent"."TalentConsentEvent" cte ' +
      'LEFT JOIN "talent"."Talent" t ON t."id" = cte."talent_id" ' +
      'WHERE t."id" IS NULL',
  },
  {
    // 4e-engagement-key: engagement.talent_id now references
    // talent_record.TalentRecord.id (the ATS heart), not Core talent.Talent.
    // Re-pointed in lockstep with the engagement validator swap — without
    // this the scanner would LEFT JOIN every engagement row to a NULL Core
    // row and report 100% orphaned.
    pair_id: 'engagement.TalentJobEngagement.talent_id->talent_record.TalentRecord',
    sql:
      'SELECT tje."id" AS row_id, tje."talent_id" AS missing_foreign_id ' +
      'FROM "engagement"."TalentJobEngagement" tje ' +
      'LEFT JOIN "talent_record"."TalentRecord" tr ON tr."id" = tje."talent_id" ' +
      'WHERE tr."id" IS NULL',
  },
  {
    pair_id: 'examination.TalentJobExamination.talent_id->talent.Talent',
    sql:
      'SELECT tje."id" AS row_id, tje."talent_id" AS missing_foreign_id ' +
      'FROM "examination"."TalentJobExamination" tje ' +
      'LEFT JOIN "talent"."Talent" t ON t."id" = tje."talent_id" ' +
      'WHERE t."id" IS NULL',
  },
  {
    pair_id: 'examination.TalentJobExamination.job_id->job_domain.Job',
    sql:
      'SELECT tje."id" AS row_id, tje."job_id" AS missing_foreign_id ' +
      'FROM "examination"."TalentJobExamination" tje ' +
      'LEFT JOIN "job_domain"."Job" j ON j."id" = tje."job_id" ' +
      'WHERE j."id" IS NULL',
  },
  {
    pair_id: 'examination.TalentJobExamination.golden_profile_id->job_domain.GoldenProfile',
    sql:
      'SELECT tje."id" AS row_id, tje."golden_profile_id" AS missing_foreign_id ' +
      'FROM "examination"."TalentJobExamination" tje ' +
      'LEFT JOIN "job_domain"."GoldenProfile" gp ON gp."id" = tje."golden_profile_id" ' +
      'WHERE gp."id" IS NULL',
  },
] as const;

@Injectable()
export class CrossSchemaConsistencyRepository implements OnModuleDestroy {
  private readonly explicitUrl?: string;
  private pool: Pool | undefined;

  constructor(@Optional() databaseUrl?: string) {
    this.explicitUrl = databaseUrl;
  }

  async scanAll(input: { sample_size: number }): Promise<CrossSchemaPairResult[]> {
    const client = await this.acquireClient();
    try {
      const results: CrossSchemaPairResult[] = [];
      for (const pair of PAIRS) {
        const { rows } = await client.query<{
          row_id: string;
          missing_foreign_id: string;
        }>(pair.sql);
        results.push({
          pair_id: pair.pair_id,
          orphan_count: rows.length,
          samples: rows.slice(0, input.sample_size).map((r) => ({
            pair_id: pair.pair_id,
            row_id: r.row_id,
            missing_foreign_id: r.missing_foreign_id,
          })),
        });
      }
      return results;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  private async acquireClient(): Promise<PoolClient> {
    if (this.pool === undefined) {
      const url = this.explicitUrl ?? process.env['DATABASE_URL'];
      if (url === undefined || url.length === 0) {
        throw new Error('DATABASE_URL is not configured');
      }
      this.pool = new Pool({ connectionString: url });
    }
    return this.pool.connect();
  }
}
