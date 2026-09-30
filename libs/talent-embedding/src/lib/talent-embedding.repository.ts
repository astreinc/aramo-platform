import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  TalentEmbeddingDescriptor,
  TalentEmbeddingRepositoryPort,
  TalentEmbeddingWorkItem,
} from './talent-embedding-repository.port.js';
import type {
  TalentEmbeddingSearchPort,
  TalentSemanticMatch,
} from './talent-embedding-search.port.js';

// Enterprise Search GS-2A — the concrete pgvector-backed Talent embedding repository. Implements the
// lifecycle persistence port (write path) + the semantic search port (read path). All vector I/O
// (the `embedding vector(1536)` column, the `<=>` cosine operator) goes through raw SQL — Prisma
// never touches the Unsupported column; the non-vector lifecycle columns use the generated client.
// The retrieval query co-locates the tenant/site visibility predicate INSIDE the vector SQL (never
// global top-k then filter), matching the GS-1 pool-open Talent contract (tenant + optional site).
const TABLE = '"talent_embedding"."TalentEmbedding"';

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

@Injectable()
export class TalentEmbeddingRepository
  implements TalentEmbeddingRepositoryPort, TalentEmbeddingSearchPort
{
  constructor(private readonly prisma: PrismaService) {}

  async claimPending(limit: number): Promise<TalentEmbeddingWorkItem[]> {
    const rows = await this.prisma.talentEmbedding.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { tenant_id: true, talent_record_id: true, site_id: true },
    });
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      talent_record_id: r.talent_record_id,
      site_id: r.site_id,
    }));
  }

  async listLiveTalentRefsMissingEmbedding(limit: number): Promise<TalentEmbeddingWorkItem[]> {
    // Cross-schema anti-join: live TalentRecords with NO TalentEmbedding row. Fully schema-qualified
    // so it resolves regardless of the connection's per-schema search_path. This is a read-only
    // UUID-ref join to the talent_record schema (no FK, no import → no nx code edge).
    const rows = await this.prisma.$queryRawUnsafe<
      { tenant_id: string; talent_record_id: string; site_id: string | null }[]
    >(
      `SELECT tr."tenant_id"::text AS tenant_id, tr."id"::text AS talent_record_id, tr."site_id"::text AS site_id
       FROM "talent_record"."TalentRecord" tr
       LEFT JOIN ${TABLE} te ON te."talent_record_id" = tr."id" AND te."tenant_id" = tr."tenant_id"
       WHERE tr."record_status" = 'live' AND te."talent_record_id" IS NULL
       ORDER BY tr."id"
       LIMIT $1`,
      limit,
    );
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      talent_record_id: r.talent_record_id,
      site_id: r.site_id,
    }));
  }

  async enqueue(input: {
    tenant_id: string;
    talent_record_id: string;
    site_id: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.talentEmbedding.upsert({
      where: {
        tenant_id_talent_record_id: {
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
        },
      },
      create: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        site_id: input.site_id,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
      // Re-drive to pending on any trigger; keep the latest site_id.
      update: { status: 'pending', site_id: input.site_id, updated_at: now },
    });
  }

  async getDescriptor(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentEmbeddingDescriptor | null> {
    const row = await this.prisma.talentEmbedding.findUnique({
      where: {
        tenant_id_talent_record_id: {
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
        },
      },
      select: { status: true, source_hash: true, embedding_model: true, dimension: true },
    });
    if (row === null) return null;
    return {
      status: row.status,
      source_hash: row.source_hash,
      embedding_model: row.embedding_model,
      dimension: row.dimension,
    };
  }

  async saveReady(input: {
    tenant_id: string;
    talent_record_id: string;
    site_id: string | null;
    vector: readonly number[];
    source_hash: string;
    embedding_model: string;
    dimension: number;
  }): Promise<void> {
    // Raw UPSERT — the `embedding` vector column is Prisma-Unsupported. ON CONFLICT keys the unique
    // (tenant_id, talent_record_id); a pending row is upgraded to ready with its vector + provenance.
    const sql = `INSERT INTO ${TABLE} ("id","tenant_id","talent_record_id","site_id","status","embedding","source_hash","embedding_model","dimension","attempt_count","created_at","updated_at")
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ready',$5::vector,$6,$7,$8,0,now(),now())
ON CONFLICT ("tenant_id","talent_record_id") DO UPDATE SET
  "embedding"=EXCLUDED."embedding","status"='ready',"source_hash"=EXCLUDED."source_hash",
  "embedding_model"=EXCLUDED."embedding_model","dimension"=EXCLUDED."dimension",
  "site_id"=EXCLUDED."site_id","last_error"=NULL,"updated_at"=now()`;
    await this.prisma.$executeRawUnsafe(
      sql,
      uuidv7(),
      input.tenant_id,
      input.talent_record_id,
      input.site_id,
      toVectorLiteral(input.vector),
      input.source_hash,
      input.embedding_model,
      input.dimension,
    );
  }

  async markFailed(input: {
    tenant_id: string;
    talent_record_id: string;
    error_message: string;
  }): Promise<void> {
    await this.prisma.talentEmbedding.updateMany({
      where: { tenant_id: input.tenant_id, talent_record_id: input.talent_record_id },
      data: {
        status: 'failed',
        attempt_count: { increment: 1 },
        last_error: input.error_message,
        updated_at: new Date(),
      },
    });
  }

  async invalidate(input: { tenant_id: string; talent_record_id: string }): Promise<void> {
    await this.prisma.talentEmbedding.deleteMany({
      where: { tenant_id: input.tenant_id, talent_record_id: input.talent_record_id },
    });
  }

  async searchSemanticForActor(input: {
    tenant_id: string;
    site_id: string | null;
    query_vector: readonly number[];
    limit: number;
  }): Promise<TalentSemanticMatch[]> {
    const params: unknown[] = [toVectorLiteral(input.query_vector), input.tenant_id];
    let where = `"tenant_id"=$2::uuid AND "status"='ready'`;
    if (input.site_id !== null) {
      params.push(input.site_id);
      where += ` AND "site_id"=$${params.length}::uuid`;
    }
    params.push(input.limit);
    const limitPlaceholder = `$${params.length}`;
    const sql = `SELECT "talent_record_id"::text AS talent_record_id, ("embedding" <=> $1::vector) AS distance
FROM ${TABLE}
WHERE ${where}
ORDER BY "embedding" <=> $1::vector
LIMIT ${limitPlaceholder}`;
    const rows = await this.prisma.$queryRawUnsafe<
      { talent_record_id: string; distance: number | string }[]
    >(sql, ...params);
    return rows.map((r) => ({
      talent_record_id: r.talent_record_id,
      distance: typeof r.distance === 'string' ? Number.parseFloat(r.distance) : r.distance,
    }));
  }
}
