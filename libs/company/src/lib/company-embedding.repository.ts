import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { VisibilityContextShape } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';

// Enterprise Search GS-2C — the concrete pgvector-backed Company embedding repository (lives in the
// company schema so the visibility predicate co-locates in the vector SQL via a same-schema join).
// Lifecycle persistence (write) + semantic retrieval (read). All vector I/O is raw SQL (the embedding
// column is Prisma-Unsupported); non-vector lifecycle columns use the generated client. Retrieval
// mirrors the GS-1 company visibility EXACTLY (tenant + optional site + see_all_company OR
// id ∈ visible_client_ids). Lean display fields come from the joined Company (no second read).
const TABLE = '"company"."CompanyEmbedding"';

export interface CompanyEmbeddingWorkItem {
  readonly tenant_id: string;
  readonly company_id: string;
}

export interface CompanyEmbeddingDescriptor {
  readonly status: 'pending' | 'ready' | 'failed';
  readonly source_hash: string | null;
  readonly embedding_model: string | null;
  readonly dimension: number | null;
}

export interface CompanySemanticMatch {
  readonly company_id: string;
  readonly name: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly industry: string | null;
  readonly distance: number;
}

// Recruiting/matching-relevant org facts only — NO contact columns (address/phone/email/url/zip), NO
// commercial/relationship columns (client_tier/supplier_status/fee_model/markup/revenue/exclusivity/
// off_limits), NO policy flags, NO free-text notes. Structural exclusion at the read boundary.
export interface CompanySemanticFactsRow {
  readonly name: string | null;
  readonly industry: string | null;
  readonly description: string | null;
  readonly key_technologies: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly ownership_type: string | null;
  readonly employee_count_band: string | null;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

@Injectable()
export class CompanyEmbeddingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSemanticFacts(input: {
    tenant_id: string;
    company_id: string;
  }): Promise<CompanySemanticFactsRow | null> {
    return this.prisma.company.findFirst({
      where: { tenant_id: input.tenant_id, id: input.company_id },
      select: {
        name: true,
        industry: true,
        description: true,
        key_technologies: true,
        city: true,
        state: true,
        country: true,
        ownership_type: true,
        employee_count_band: true,
      },
    });
  }

  async claimPending(limit: number): Promise<CompanyEmbeddingWorkItem[]> {
    const rows = await this.prisma.companyEmbedding.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { tenant_id: true, company_id: true },
    });
    return rows.map((r) => ({ tenant_id: r.tenant_id, company_id: r.company_id }));
  }

  async listCompaniesMissingEmbedding(limit: number): Promise<CompanyEmbeddingWorkItem[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ tenant_id: string; company_id: string }[]>(
      `SELECT c."tenant_id"::text AS tenant_id, c."id"::text AS company_id
       FROM "company"."Company" c
       LEFT JOIN ${TABLE} ce ON ce."company_id" = c."id" AND ce."tenant_id" = c."tenant_id"
       WHERE ce."company_id" IS NULL
       ORDER BY c."id"
       LIMIT $1`,
      limit,
    );
    return rows.map((r) => ({ tenant_id: r.tenant_id, company_id: r.company_id }));
  }

  async enqueue(input: { tenant_id: string; company_id: string }): Promise<void> {
    const now = new Date();
    await this.prisma.companyEmbedding.upsert({
      where: { tenant_id_company_id: { tenant_id: input.tenant_id, company_id: input.company_id } },
      create: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        company_id: input.company_id,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
      update: { status: 'pending', updated_at: now },
    });
  }

  async getDescriptor(input: {
    tenant_id: string;
    company_id: string;
  }): Promise<CompanyEmbeddingDescriptor | null> {
    const row = await this.prisma.companyEmbedding.findUnique({
      where: { tenant_id_company_id: { tenant_id: input.tenant_id, company_id: input.company_id } },
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
    company_id: string;
    vector: readonly number[];
    source_hash: string;
    embedding_model: string;
    dimension: number;
  }): Promise<void> {
    const sql = `INSERT INTO ${TABLE} ("id","tenant_id","company_id","status","embedding","source_hash","embedding_model","dimension","attempt_count","created_at","updated_at")
VALUES ($1::uuid,$2::uuid,$3::uuid,'ready',$4::vector,$5,$6,$7,0,now(),now())
ON CONFLICT ("tenant_id","company_id") DO UPDATE SET
  "embedding"=EXCLUDED."embedding","status"='ready',"source_hash"=EXCLUDED."source_hash",
  "embedding_model"=EXCLUDED."embedding_model","dimension"=EXCLUDED."dimension",
  "last_error"=NULL,"updated_at"=now()`;
    await this.prisma.$executeRawUnsafe(
      sql,
      uuidv7(),
      input.tenant_id,
      input.company_id,
      toVectorLiteral(input.vector),
      input.source_hash,
      input.embedding_model,
      input.dimension,
    );
  }

  async markFailed(input: {
    tenant_id: string;
    company_id: string;
    error_message: string;
  }): Promise<void> {
    await this.prisma.companyEmbedding.updateMany({
      where: { tenant_id: input.tenant_id, company_id: input.company_id },
      data: {
        status: 'failed',
        attempt_count: { increment: 1 },
        last_error: input.error_message,
        updated_at: new Date(),
      },
    });
  }

  async invalidate(input: { tenant_id: string; company_id: string }): Promise<void> {
    await this.prisma.companyEmbedding.deleteMany({
      where: { tenant_id: input.tenant_id, company_id: input.company_id },
    });
  }

  // Nearest ready embeddings for this actor's Company visibility — mirrors the GS-1 company read:
  // tenant + optional site + (see_all_company → no filter; else id ∈ visible_client_ids), co-located
  // INSIDE the vector SQL via a same-schema join (never global top-k then filter).
  async searchSemanticForActor(input: {
    tenant_id: string;
    visibility: VisibilityContextShape;
    site_id?: string;
    query_vector: readonly number[];
    limit: number;
  }): Promise<CompanySemanticMatch[]> {
    const params: unknown[] = [toVectorLiteral(input.query_vector), input.tenant_id];
    const clauses = [`ce."tenant_id" = $2::uuid`, `ce."status" = 'ready'`];

    if (input.site_id !== undefined) {
      params.push(input.site_id);
      clauses.push(`c."site_id" = $${params.length}::uuid`);
    }

    const vis = input.visibility;
    if (!vis.see_all_company && vis.visible_client_ids !== null) {
      params.push(Array.from(vis.visible_client_ids));
      clauses.push(`c."id" = ANY($${params.length}::uuid[])`);
    }

    params.push(input.limit);
    const limitParam = `$${params.length}`;

    const sql = `SELECT c."id"::text AS company_id, c."name" AS name, c."city" AS city, c."state" AS state,
       c."industry" AS industry, (ce."embedding" <=> $1::vector) AS distance
FROM ${TABLE} ce
JOIN "company"."Company" c ON c."id" = ce."company_id" AND c."tenant_id" = ce."tenant_id"
WHERE ${clauses.join(' AND ')}
ORDER BY ce."embedding" <=> $1::vector
LIMIT ${limitParam}`;

    const rows = await this.prisma.$queryRawUnsafe<
      {
        company_id: string;
        name: string;
        city: string | null;
        state: string | null;
        industry: string | null;
        distance: number | string;
      }[]
    >(sql, ...params);
    return rows.map((r) => ({
      company_id: r.company_id,
      name: r.name,
      city: r.city,
      state: r.state,
      industry: r.industry,
      distance: typeof r.distance === 'string' ? Number.parseFloat(r.distance) : r.distance,
    }));
  }
}
