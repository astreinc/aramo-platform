import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { VisibilityContextShape } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';

// Enterprise Search GS-2B — the concrete pgvector-backed Requisition embedding repository (lives in
// the requisition schema so the OR-union visibility predicate co-locates in the vector SQL via
// SAME-schema joins). Lifecycle persistence (write) + semantic retrieval (read). All vector I/O is
// raw SQL (the `embedding vector(1536)` column is Prisma-Unsupported); non-vector lifecycle columns
// use the generated client. Retrieval mirrors searchLexicalForActor's authority EXACTLY (tenant +
// optional site + buildVisibilityWhere OR-union) and keeps terminal Requisitions eligible (no
// lifecycle-state filter, matching GS-1).
const TABLE = '"requisition"."RequisitionEmbedding"';

export interface RequisitionEmbeddingWorkItem {
  readonly tenant_id: string;
  readonly requisition_id: string;
}

export interface RequisitionEmbeddingDescriptor {
  readonly status: 'pending' | 'ready' | 'failed';
  readonly source_hash: string | null;
  readonly embedding_model: string | null;
  readonly dimension: number | null;
}

// Enriched with the lean display fields from the joined Requisition, so the adapter builds a hit
// without a second hydration read (the vector query already applied tenant + site + OR-union).
export interface RequisitionSemanticMatch {
  readonly requisition_id: string;
  readonly title: string;
  readonly requisition_number: number;
  readonly city: string | null;
  readonly state: string | null;
  readonly distance: number;
}

// The recruiting-fact scalars only — NO commercial columns (structural commercial exclusion, P7).
export interface RequisitionSemanticFactsRow {
  readonly title: string | null;
  readonly description: string | null;
  readonly type: string | null;
  readonly job_type: string | null;
  readonly role_family: string | null;
  readonly labor_category: string | null;
  readonly seniority_level: string | null;
  readonly work_arrangement: string | null;
  readonly work_authorization: string | null;
  readonly city: string | null;
  readonly state: string | null;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

@Injectable()
export class RequisitionEmbeddingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The recruiting-fact scalars for the GS-2B semantic projection — NO commercial columns are
  // selected (structural commercial exclusion at the read boundary). Returns null if the req is gone.
  async findSemanticFacts(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<RequisitionSemanticFactsRow | null> {
    return this.prisma.requisition.findFirst({
      where: { tenant_id: input.tenant_id, id: input.requisition_id },
      select: {
        title: true,
        description: true,
        type: true,
        job_type: true,
        role_family: true,
        labor_category: true,
        seniority_level: true,
        work_arrangement: true,
        work_authorization: true,
        city: true,
        state: true,
      },
    });
  }

  async claimPending(limit: number): Promise<RequisitionEmbeddingWorkItem[]> {
    const rows = await this.prisma.requisitionEmbedding.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { tenant_id: true, requisition_id: true },
    });
    return rows.map((r) => ({ tenant_id: r.tenant_id, requisition_id: r.requisition_id }));
  }

  // All Requisitions (any lifecycle state — terminal eligible, matching GS-1) with NO embedding row.
  async listReqsMissingEmbedding(limit: number): Promise<RequisitionEmbeddingWorkItem[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ tenant_id: string; requisition_id: string }[]>(
      `SELECT r."tenant_id"::text AS tenant_id, r."id"::text AS requisition_id
       FROM "requisition"."Requisition" r
       LEFT JOIN ${TABLE} re ON re."requisition_id" = r."id" AND re."tenant_id" = r."tenant_id"
       WHERE re."requisition_id" IS NULL
       ORDER BY r."id"
       LIMIT $1`,
      limit,
    );
    return rows.map((r) => ({ tenant_id: r.tenant_id, requisition_id: r.requisition_id }));
  }

  async enqueue(input: { tenant_id: string; requisition_id: string }): Promise<void> {
    const now = new Date();
    await this.prisma.requisitionEmbedding.upsert({
      where: {
        tenant_id_requisition_id: { tenant_id: input.tenant_id, requisition_id: input.requisition_id },
      },
      create: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
      update: { status: 'pending', updated_at: now },
    });
  }

  async getDescriptor(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<RequisitionEmbeddingDescriptor | null> {
    const row = await this.prisma.requisitionEmbedding.findUnique({
      where: {
        tenant_id_requisition_id: { tenant_id: input.tenant_id, requisition_id: input.requisition_id },
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
    requisition_id: string;
    vector: readonly number[];
    source_hash: string;
    embedding_model: string;
    dimension: number;
  }): Promise<void> {
    const sql = `INSERT INTO ${TABLE} ("id","tenant_id","requisition_id","status","embedding","source_hash","embedding_model","dimension","attempt_count","created_at","updated_at")
VALUES ($1::uuid,$2::uuid,$3::uuid,'ready',$4::vector,$5,$6,$7,0,now(),now())
ON CONFLICT ("tenant_id","requisition_id") DO UPDATE SET
  "embedding"=EXCLUDED."embedding","status"='ready',"source_hash"=EXCLUDED."source_hash",
  "embedding_model"=EXCLUDED."embedding_model","dimension"=EXCLUDED."dimension",
  "last_error"=NULL,"updated_at"=now()`;
    await this.prisma.$executeRawUnsafe(
      sql,
      uuidv7(),
      input.tenant_id,
      input.requisition_id,
      toVectorLiteral(input.vector),
      input.source_hash,
      input.embedding_model,
      input.dimension,
    );
  }

  async markFailed(input: {
    tenant_id: string;
    requisition_id: string;
    error_message: string;
  }): Promise<void> {
    await this.prisma.requisitionEmbedding.updateMany({
      where: { tenant_id: input.tenant_id, requisition_id: input.requisition_id },
      data: {
        status: 'failed',
        attempt_count: { increment: 1 },
        last_error: input.error_message,
        updated_at: new Date(),
      },
    });
  }

  async invalidate(input: { tenant_id: string; requisition_id: string }): Promise<void> {
    await this.prisma.requisitionEmbedding.deleteMany({
      where: { tenant_id: input.tenant_id, requisition_id: input.requisition_id },
    });
  }

  // Nearest ready embeddings for this actor's Requisition visibility. Mirrors searchLexicalForActor:
  // tenant + optional site + the buildVisibilityWhere OR-union — co-located INSIDE the vector SQL via
  // same-schema joins (never global top-k then filter). Terminal Requisitions remain eligible.
  async searchSemanticForActor(input: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
    query_vector: readonly number[];
    limit: number;
  }): Promise<RequisitionSemanticMatch[]> {
    const params: unknown[] = [toVectorLiteral(input.query_vector), input.tenant_id];
    const clauses = [`re."tenant_id" = $2::uuid`, `re."status" = 'ready'`];

    if (input.site_id !== undefined) {
      params.push(input.site_id);
      clauses.push(`r."site_id" = $${params.length}::uuid`);
    }

    // Mirror buildVisibilityWhere: see_all_requisition → no filter; null visible_client_ids → no
    // filter; else the OR-union (company client-axis OR direct assignment).
    const vis = input.visibility;
    if (!vis.see_all_requisition && vis.visible_client_ids !== null) {
      const clientIds = Array.from(vis.visible_client_ids);
      params.push(clientIds);
      const clientParam = `$${params.length}::uuid[]`;
      params.push(vis.actor_user_id);
      const actorParam = `$${params.length}::uuid`;
      clauses.push(
        `( r."company_id" = ANY(${clientParam}) OR EXISTS (SELECT 1 FROM "requisition"."RequisitionAssignment" a WHERE a."requisition_id" = r."id" AND a."user_id" = ${actorParam}) )`,
      );
    }

    params.push(input.limit);
    const limitParam = `$${params.length}`;

    const sql = `SELECT r."id"::text AS requisition_id, r."title" AS title, r."requisition_number" AS requisition_number,
       r."city" AS city, r."state" AS state, (re."embedding" <=> $1::vector) AS distance
FROM ${TABLE} re
JOIN "requisition"."Requisition" r ON r."id" = re."requisition_id" AND r."tenant_id" = re."tenant_id"
WHERE ${clauses.join(' AND ')}
ORDER BY re."embedding" <=> $1::vector
LIMIT ${limitParam}`;

    const rows = await this.prisma.$queryRawUnsafe<
      {
        requisition_id: string;
        title: string;
        requisition_number: number | string;
        city: string | null;
        state: string | null;
        distance: number | string;
      }[]
    >(sql, ...params);
    return rows.map((r) => ({
      requisition_id: r.requisition_id,
      title: r.title,
      requisition_number:
        typeof r.requisition_number === 'string' ? Number.parseInt(r.requisition_number, 10) : r.requisition_number,
      city: r.city,
      state: r.state,
      distance: typeof r.distance === 'string' ? Number.parseFloat(r.distance) : r.distance,
    }));
  }
}
