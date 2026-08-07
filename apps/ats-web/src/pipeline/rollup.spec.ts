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
  };
}

describe('rollupByRequisition', () => {
  it('counts active (non-terminal) and submitted (submitted-bucket+) per req', () => {
    const r = rollupByRequisition([
      pipe('r1', 'no_contact'), // active, not submitted
      pipe('r1', 'submitted'), // active + submitted
      pipe('r1', 'interviewing'), // active + submitted
      pipe('r1', 'placed'), // terminal (not active) + submitted
      pipe('r1', 'not_in_consideration'), // terminal, not submitted
    ]);
    expect(r['r1']).toEqual({ active: 3, submitted: 3 });
  });

  it('groups independently by requisition', () => {
    const r = rollupByRequisition([
      pipe('r1', 'submitted'),
      pipe('r2', 'no_contact'),
    ]);
    expect(r['r1']).toEqual({ active: 1, submitted: 1 });
    expect(r['r2']).toEqual({ active: 1, submitted: 0 });
  });

  it('client_declined counts as submitted (it reached the client)', () => {
    const r = rollupByRequisition([pipe('r1', 'client_declined')]);
    // terminal → not active; declined-after-submit → submitted.
    expect(r['r1']).toEqual({ active: 0, submitted: 1 });
  });
});

describe('funnelByRequisition', () => {
  it('breaks each req into the 6 funnel buckets with a total of every entry', () => {
    const f = funnelByRequisition([
      pipe('r1', 'no_contact'), // sourced
      pipe('r1', 'submitted'), // submitted
      pipe('r1', 'interviewing'), // interview
      pipe('r1', 'placed'), // placed
    ]);
    expect(f['r1'].total).toBe(4);
    const byKey = Object.fromEntries(
      f['r1'].cells.map((c) => [c.key, c.count]),
    );
    expect(byKey).toEqual({
      sourced: 1,
      qualifying: 0,
      submitted: 1,
      interview: 1,
      offer: 0,
      placed: 1,
    });
    // Labels are FUNNEL_BUCKETS' own names (drives the R2 stat block).
    const submitted = f['r1'].cells.find((c) => c.key === 'submitted');
    const interview = f['r1'].cells.find((c) => c.key === 'interview');
    expect(submitted?.label).toBe('Submitted');
    expect(interview?.label).toBe('Interview');
  });

  it('groups independently by requisition and omits reqs with no entries', () => {
    const f = funnelByRequisition([
      pipe('r1', 'submitted'),
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
    // ONE talent, ONE req, TWO episodes: an old client_declined + a current live
    // submitted (legal post-E6). Person/funnel views must count this talent ONCE,
    // in its CURRENT (live) stage.
    const pipelines = [
      pipeFor('r1', 'client_declined', 'ada', { id: 'ep-old', created_at: '2026-01-01' }),
      pipeFor('r1', 'submitted', 'ada', { id: 'ep-new', created_at: '2026-02-01' }),
    ];
    const roll = rollupByRequisition(pipelines);
    expect(roll['r1']).toEqual({ active: 1, submitted: 1 }); // one talent, live+submitted
    const fun = funnelByRequisition(pipelines);
    expect(fun['r1'].total).toBe(1); // distinct talent, NOT 2 episodes
    const byKey = Object.fromEntries(fun['r1'].cells.map((c) => [c.key, c.count]));
    expect(byKey.submitted).toBe(1); // current stage
    expect(byKey.placed).toBe(0);
  });

  it('collapse picks the LIVE episode over a terminal one', () => {
    const current = collapseToCurrentEpisode([
      pipeFor('r1', 'placed', 'ada', { id: 'a', created_at: '2026-03-01' }),
      pipeFor('r1', 'qualifying', 'ada', { id: 'b', created_at: '2026-01-01' }),
    ]);
    expect(current).toHaveLength(1);
    expect(current[0]!.status).toBe('qualifying'); // live wins even though older
  });

  it('deterministic tiebreak: identical created_at → higher id wins, every run', () => {
    const build = () => [
      pipeFor('r1', 'client_declined', 'ada', { id: 'id-1', created_at: 'same' }),
      pipeFor('r1', 'not_in_consideration', 'ada', { id: 'id-2', created_at: 'same' }),
    ];
    // Two terminal episodes, identical created_at, different ids. The collapse must
    // pick the SAME one deterministically (id DESC → 'id-2') regardless of input order.
    const a = collapseToCurrentEpisode(build());
    const b = collapseToCurrentEpisode([...build()].reverse());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).toBe('id-2');
    expect(b[0]!.id).toBe('id-2'); // same pick, order-independent
  });

  it('the collapse is opt-in: an episode list keeps ALL episodes (history view unaffected)', () => {
    const pipelines = [
      pipeFor('r1', 'client_declined', 'ada', { id: 'ep-old', created_at: '2026-01-01' }),
      pipeFor('r1', 'submitted', 'ada', { id: 'ep-new', created_at: '2026-02-01' }),
    ];
    // The raw list still has both episodes — only the business helpers collapse.
    expect(pipelines).toHaveLength(2);
    expect(collapseToCurrentEpisode(pipelines)).toHaveLength(1);
  });
});
