import { describe, expect, it } from 'vitest';

import {
  collapseToCurrentEpisode,
  funnelByRequisition,
  rollupByRequisition,
} from './rollup';
import type { PipelineStatus, PipelineView } from './types';

// Each entry is a DISTINCT talent by default (unique talent_record_id) — the
// business counts below are "N talents in N stages". The E6 collapse tests below
// deliberately reuse ONE talent to exercise the coexisting-episode collapse.
function pipe(requisition_id: string, status: PipelineStatus): PipelineView {
  return pipeFor(requisition_id, status, `tal-${requisition_id}-${status}`);
}

function pipeFor(
  requisition_id: string,
  status: PipelineStatus,
  talent_record_id: string,
  opts: { id?: string; created_at?: string } = {},
): PipelineView {
  return {
    id: opts.id ?? `${requisition_id}-${status}-${talent_record_id}`,
    tenant_id: 't',
    site_id: null,
    talent_record_id,
    requisition_id,
    status,
    created_at: opts.created_at ?? 'x',
    updated_at: 'x',
    version: 0,
  };
}

describe('rollupByRequisition', () => {
  it('counts active (non-terminal) talents per req', () => {
    const r = rollupByRequisition([
      pipe('r1', 'no_contact'), // active
      pipe('r1', 'qualifying'), // active
      pipe('r1', 'qualified'), // active
      pipe('r1', 'completed'), // terminal → not active
      pipe('r1', 'not_in_consideration'), // terminal → not active
    ]);
    expect(r['r1']).toEqual({ active: 3 });
  });

  it('groups independently by requisition', () => {
    const r = rollupByRequisition([
      pipe('r1', 'qualifying'),
      pipe('r2', 'no_contact'),
    ]);
    expect(r['r1']).toEqual({ active: 1 });
    expect(r['r2']).toEqual({ active: 1 });
  });

  it('terminals are not counted as active', () => {
    const r = rollupByRequisition([
      pipe('r1', 'completed'),
      pipe('r1', 'not_in_consideration'),
    ]);
    expect(r['r1']).toEqual({ active: 0 });
  });
});

describe('funnelByRequisition', () => {
  it('breaks each req into the pipeline-owned funnel buckets with a total of every entry', () => {
    const f = funnelByRequisition([
      pipe('r1', 'no_contact'), // early_engagement
      pipe('r1', 'qualifying'), // qualifying
      pipe('r1', 'qualified'), // qualified
      pipe('r1', 'completed'), // closed
    ]);
    expect(f['r1'].total).toBe(4);
    const byKey = Object.fromEntries(
      f['r1'].cells.map((c) => [c.key, c.count]),
    );
    expect(byKey).toEqual({
      early_engagement: 1,
      qualifying: 1,
      qualified: 1,
      closed: 1,
    });
  });

  it('groups independently by requisition and omits reqs with no entries', () => {
    const f = funnelByRequisition([
      pipe('r1', 'qualifying'),
      pipe('r2', 'no_contact'),
    ]);
    expect(f['r1'].total).toBe(1);
    expect(f['r2'].total).toBe(1);
    expect(f['r3']).toBeUndefined();
  });
});

// ==== E6 B-projection (Q-4) — FE person/funnel views do not double-count ====
describe('E6 collapse — coexisting episodes are counted once per (talent, req)', () => {
  it('B-projection: a talent with a historical terminal + a current live episode is NOT double-counted', () => {
    // ONE talent, ONE req, TWO episodes: an old terminal + a current live one.
    // Person/funnel views must count this talent ONCE, in its CURRENT (live) stage.
    const pipelines = [
      pipeFor('r1', 'not_in_consideration', 'ada', { id: 'ep-old', created_at: '2026-01-01' }),
      pipeFor('r1', 'qualifying', 'ada', { id: 'ep-new', created_at: '2026-02-01' }),
    ];
    const roll = rollupByRequisition(pipelines);
    expect(roll['r1']).toEqual({ active: 1 }); // one talent, live
    const fun = funnelByRequisition(pipelines);
    expect(fun['r1'].total).toBe(1); // distinct talent, NOT 2 episodes
    const byKey = Object.fromEntries(fun['r1'].cells.map((c) => [c.key, c.count]));
    expect(byKey.qualifying).toBe(1); // current stage
    expect(byKey.closed).toBe(0);
  });

  it('collapse picks the LIVE episode over a terminal one', () => {
    const current = collapseToCurrentEpisode([
      pipeFor('r1', 'completed', 'ada', { id: 'a', created_at: '2026-03-01' }),
      pipeFor('r1', 'qualifying', 'ada', { id: 'b', created_at: '2026-01-01' }),
    ]);
    expect(current).toHaveLength(1);
    expect(current[0]!.status).toBe('qualifying'); // live wins even though older
  });

  it('deterministic tiebreak: identical created_at → higher id wins, every run', () => {
    const build = () => [
      pipeFor('r1', 'completed', 'ada', { id: 'id-1', created_at: 'same' }),
      pipeFor('r1', 'not_in_consideration', 'ada', { id: 'id-2', created_at: 'same' }),
    ];
    const a = collapseToCurrentEpisode(build());
    const b = collapseToCurrentEpisode([...build()].reverse());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).toBe('id-2');
    expect(b[0]!.id).toBe('id-2'); // same pick, order-independent
  });

  it('the collapse is opt-in: an episode list keeps ALL episodes (history view unaffected)', () => {
    const pipelines = [
      pipeFor('r1', 'not_in_consideration', 'ada', { id: 'ep-old', created_at: '2026-01-01' }),
      pipeFor('r1', 'qualifying', 'ada', { id: 'ep-new', created_at: '2026-02-01' }),
    ];
    expect(pipelines).toHaveLength(2);
    expect(collapseToCurrentEpisode(pipelines)).toHaveLength(1);
  });
});
