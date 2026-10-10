import { describe, expect, it } from 'vitest';

import { RtrQualifiedTransitionGuard } from '../rtr/rtr-qualified-transition-guard.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root guard that joins the
// Pipeline `qualified` milestone to the ONE RTR readiness predicate (ADR-0029 wall).
// The PipelineRepository passes the exact (talent, requisition) from the row it already
// loaded (after the no-op + legality checks), so the guard just reuses
// DocumentReadinessGate.assess: ungated when no RTR is required; refuse with
// PIPELINE_QUALIFY_REQUIRES_RTR (422) when required + not executed.

function makeGuard(verdict: { satisfied: boolean; deny: string | null }) {
  const readiness = { assess: async () => verdict };
  return new RtrQualifiedTransitionGuard(readiness as never);
}

const input = { tenant_id: 't1', talent_id: 'tal-1', requisition_id: 'req-1', requestId: 'r' };

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'NO_THROW',
    (e) => (e as { code?: string }).code ?? 'NO_CODE',
  );
}

describe('RtrQualifiedTransitionGuard (§29-32)', () => {
  it('RTR not required → ungated (no throw)', async () => {
    expect(await codeOf(makeGuard({ satisfied: true, deny: null }).assertCanQualify(input))).toBe('NO_THROW');
  });

  it('RTR required + executed → allowed (no throw)', async () => {
    expect(await codeOf(makeGuard({ satisfied: true, deny: null }).assertCanQualify(input))).toBe('NO_THROW');
  });

  it('RTR required + NOT executed → refuse with PIPELINE_QUALIFY_REQUIRES_RTR (422)', async () => {
    const err = await makeGuard({ satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' })
      .assertCanQualify(input)
      .catch((e) => e);
    expect((err as { code?: string }).code).toBe('PIPELINE_QUALIFY_REQUIRES_RTR');
    expect((err as { statusCode?: number }).statusCode).toBe(422);
  });
});
