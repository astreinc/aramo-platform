// A minimal raw-SQL executor (pg.Client-shaped). Injected so the CLI
// points it at DATABASE_URL and the acceptance spec points it at its
// testcontainer. Mirrors the erase-talent PgExec — the reset crosses
// many schemas via fully-qualified table names, which needs raw SQL
// (no single Prisma client owns >1 schema; a lib import would breach
// the scope:ats nx wall). One connection = one session, so a BEGIN /
// LOCK / … / COMMIT sequence issued through it shares one transaction.
export interface PgExec {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
