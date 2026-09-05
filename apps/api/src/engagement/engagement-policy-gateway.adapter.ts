import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  ENGAGEMENT_PACKAGE_LIKE,
  type EngagementPolicyGateway,
  type InsertEngagementVersionInput,
  type StoredPolicyVersionRow,
} from '@aramo/engagement';

// COMM-C3 — the apps/api raw-SQL adapter for the Engagement persistence PORT
// (directive R4/R12/R13). It reuses the governed StoredPolicyVersion table
// (policy_store schema) via parameterized raw SQL — no generated Prisma client
// crosses the lib boundary, mirroring the SubmitTalent OrchestratorDb pattern.
// The scope layer lives in package_name (R4 "no second table"); this adapter is
// provider-neutral and never reads communication evidence.

interface PolicyStoreRawTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
interface PolicyStoreRawDb extends PolicyStoreRawTx {
  $transaction<T>(fn: (tx: PolicyStoreRawTx) => Promise<T>): Promise<T>;
}

/** DI token for the policy_store-capable connection (bound to policy-store PrismaService). */
export const ENGAGEMENT_POLICY_DB = 'EngagementPolicyDb';

interface Row {
  package_name: string;
  version: string;
  definition: unknown;
  checksum: string;
  effective_from: Date;
  effective_to: Date | null;
  published_by: string;
  published_at: Date;
}

const SELECT_COLS =
  '"package_name","version","definition","checksum","effective_from","effective_to","published_by","published_at"';

@Injectable()
export class EngagementPolicyGatewayAdapter implements EngagementPolicyGateway {
  constructor(@Inject(ENGAGEMENT_POLICY_DB) private readonly db: PolicyStoreRawDb) {}

  async findVersionRows(
    tenantId: string,
    packageNames: readonly string[],
  ): Promise<StoredPolicyVersionRow[]> {
    if (packageNames.length === 0) return [];
    const rows = await this.db.$queryRawUnsafe<Row[]>(
      `SELECT ${SELECT_COLS} FROM "policy_store"."StoredPolicyVersion"
        WHERE "tenant_id" = $1::uuid AND "package_name" = ANY($2::text[])`,
      tenantId,
      packageNames as string[],
    );
    return rows.map(toRow);
  }

  async tenantHasAnyEngagementPolicy(tenantId: string): Promise<boolean> {
    const rows = await this.db.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS "one" FROM "policy_store"."StoredPolicyVersion"
        WHERE "tenant_id" = $1::uuid AND "package_name" LIKE $2 LIMIT 1`,
      tenantId,
      ENGAGEMENT_PACKAGE_LIKE,
    );
    return rows.length > 0;
  }

  async insertVersion(input: InsertEngagementVersionInput): Promise<StoredPolicyVersionRow> {
    return this.db.$transaction(async (tx) => {
      const dup = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "policy_store"."StoredPolicyVersion"
          WHERE "tenant_id" = $1::uuid AND "package_name" = $2 AND "version" = $3`,
        input.tenant_id,
        input.package_name,
        input.version,
      );
      if (dup.length > 0) {
        throw new AramoError(
          'ENGAGEMENT_POLICY_SCHEMA_INVALID',
          `engagement policy ${input.package_name}@${input.version} already published (immutable)`,
          422,
          { requestId: '', details: { package_name: input.package_name, version: input.version } },
        );
      }
      const open = await tx.$queryRawUnsafe<Array<{ id: string; effective_from: Date }>>(
        `SELECT "id","effective_from" FROM "policy_store"."StoredPolicyVersion"
          WHERE "tenant_id" = $1::uuid AND "package_name" = $2 AND "effective_to" IS NULL`,
        input.tenant_id,
        input.package_name,
      );
      if (open.length > 0) {
        const openRow = open[0]!;
        if (input.effective_from.getTime() <= openRow.effective_from.getTime()) {
          throw new AramoError(
            'ENGAGEMENT_POLICY_SCHEMA_INVALID',
            'effective_from must be strictly after the current open version',
            422,
            { requestId: '', details: {} },
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE "policy_store"."StoredPolicyVersion" SET "effective_to" = $2
            WHERE "id" = $1::uuid`,
          openRow.id,
          input.effective_from,
        );
      }
      const inserted = await tx.$queryRawUnsafe<Row[]>(
        `INSERT INTO "policy_store"."StoredPolicyVersion"
           ("id","tenant_id","package_name","version","definition","checksum","effective_from","effective_to","published_by","published_at")
         VALUES (gen_random_uuid(),$1::uuid,$2,$3,$4::jsonb,$5,$6,NULL,$7::uuid,NOW())
         RETURNING ${SELECT_COLS}`,
        input.tenant_id,
        input.package_name,
        input.version,
        JSON.stringify(input.definition),
        input.checksum,
        input.effective_from,
        input.published_by,
      );
      return toRow(inserted[0]!);
    });
  }
}

function toRow(r: Row): StoredPolicyVersionRow {
  return {
    package_name: r.package_name,
    version: r.version,
    definition: r.definition,
    checksum: r.checksum,
    effective_from: new Date(r.effective_from),
    effective_to: r.effective_to === null ? null : new Date(r.effective_to),
    published_by: r.published_by,
    published_at: new Date(r.published_at),
  };
}
