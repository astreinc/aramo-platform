import { describe, expect, it } from 'vitest';

import { funnelByRequisition, rollupByRequisition } from './rollup';
import type { PipelineStatus, PipelineView } from './types';

function pipe(requisition_id: string, status: PipelineStatus): PipelineView {
  return {
    id: `${requisition_id}-${status}`,
    tenant_id: 't',
    site_id: null,
    talent_record_id: 'tal',
    requisition_id,
    status,
    created_at: 'x',
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
