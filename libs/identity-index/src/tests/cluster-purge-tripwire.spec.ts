import { describe, expect, it, vi } from 'vitest';

import {
  CLUSTER_PURGE_STATEMENTS,
  ClusterPurgeService,
  purgeClusterViaExec,
  type ClusterPurgeExec,
} from '../lib/cluster-purge.service.js';

// TR-2b B2b (Directive §PR-2.1 tripwire) — pin BOTH purgeCluster bindings (the DI
// Prisma path used by the sweep, and the raw-PgExec path used by the erasure
// engine) to the ONE shared ordered statement array. If either path ever drifts
// from CLUSTER_PURGE_STATEMENTS — reorders, drops, or hand-writes a statement —
// this spec goes red. "One primitive, two bindings" is thereby structural.

const CLUSTER_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const EXPECTED_SQL = CLUSTER_PURGE_STATEMENTS.map((s) => s.sql);

// A recording executor: captures the (sql, params) it is handed, in order.
function recordingExec(): {
  exec: ClusterPurgeExec;
  sql: string[];
  params: unknown[][];
} {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const exec: ClusterPurgeExec = {
    query: async (s, p) => {
      sql.push(s);
      params.push(p);
      return { rowCount: 1 };
    },
  };
  return { exec, sql, params };
}

describe('cluster-purge tripwire — both bindings run the shared array verbatim', () => {
  it('CLUSTER_PURGE_STATEMENTS is the RESTRICT-safe 5-statement order', () => {
    expect(CLUSTER_PURGE_STATEMENTS.map((s) => s.key)).toEqual([
      'dormant_links_deleted',
      'fingerprints_deleted', // child — before the parent
      'clusters_deleted', // parent
      'arrival_stamps_nulled',
      'portal_users_nulled',
    ]);
  });

  it('the raw-PgExec binding issues exactly the shared statements, in order, bound to the cluster id', async () => {
    const { exec, sql, params } = recordingExec();
    const result = await purgeClusterViaExec(exec, CLUSTER_ID, 'test');

    expect(sql).toEqual(EXPECTED_SQL);
    expect(params).toEqual(EXPECTED_SQL.map(() => [CLUSTER_ID]));
    expect(result.cluster_id).toBe(CLUSTER_ID);
    // Each statement's rowCount (1) mapped to its result field.
    expect(result.fingerprints_deleted).toBe(1);
    expect(result.portal_users_nulled).toBe(1);
  });

  it('the DI Prisma binding issues exactly the shared statements, in order (via $executeRawUnsafe)', async () => {
    const seen: Array<{ sql: string; param: unknown }> = [];
    // A fake tx whose $executeRawUnsafe records the SQL + first param.
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string, param: unknown) => {
        seen.push({ sql, param });
        return 1;
      }),
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new ClusterPurgeService(prisma as never);

    await service.purgeCluster(CLUSTER_ID, 'test');

    expect(seen.map((s) => s.sql)).toEqual(EXPECTED_SQL);
    expect(seen.every((s) => s.param === CLUSTER_ID)).toBe(true);
  });
});
