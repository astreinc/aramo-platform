import { describe, expect, it } from 'vitest';

import { rollupByRequisition } from './rollup';
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
