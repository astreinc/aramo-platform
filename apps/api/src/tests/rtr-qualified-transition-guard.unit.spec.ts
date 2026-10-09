import { describe, expect, it } from 'vitest';

import { RtrQualifiedTransitionGuard } from '../rtr/rtr-qualified-transition-guard.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root guard that joins the
// Pipeline `qualified` milestone to the ONE RTR readiness predicate (ADR-0029 wall).
// It resolves the pipeline's exact (talent, requisition) and reuses
// DocumentReadinessGate.assess: ungated when no RTR is required; refuse with
// PIPELINE_QUALIFY_REQUIRES_RTR (422) when required + not executed; a missing/invisible
// pipeline is a no-op (the repository transition conceals it as 404).

const PIPELINE = { id: 'p1', talent_record_id: 'tal-1', requisition_id: 'req-1' };

function makeGuard(opts: {
  pipeline?: typeof PIPELINE | null;
  verdict?: { satisfied: boolean; deny: string | null };
}) {
  const pipelines = {
    findById: async () => (opts.pipeline === undefined ? PIPELINE : opts.pipeline),
  };
  const readiness = {
    assess: async () => opts.verdict ?? { satisfied: true, deny: null },
  };
  return new RtrQualifiedTransitionGuard(pipelines as never, readiness as never);
}

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'NO_THROW',
    (e) => (e as { code?: string }).code ?? 'NO_CODE',
  );
}

describe('RtrQualifiedTransitionGuard (§29-32)', () => {
  const input = { tenant_id: 't1', pipeline_id: 'p1', requestId: 'r' };

  it('RTR not required → ungated (no throw)', async () => {
    const guard = makeGuard({ verdict: { satisfied: true, deny: null } });
    expect(await codeOf(guard.assertCanQualify(input))).toBe('NO_THROW');
  });

  it('RTR required + executed → allowed (no throw)', async () => {
    const guard = makeGuard({ verdict: { satisfied: true, deny: null } });
    expect(await codeOf(guard.assertCanQualify(input))).toBe('NO_THROW');
  });

  it('RTR required + NOT executed → refuse with PIPELINE_QUALIFY_REQUIRES_RTR (422)', async () => {
    const guard = makeGuard({ verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' } });
    const err = await guard.assertCanQualify(input).catch((e) => e);
    expect((err as { code?: string }).code).toBe('PIPELINE_QUALIFY_REQUIRES_RTR');
    expect((err as { statusCode?: number }).statusCode).toBe(422);
  });

  it('missing / invisible pipeline → no-op (concealment handled by the repository 404)', async () => {
    const guard = makeGuard({ pipeline: null, verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' } });
    expect(await codeOf(guard.assertCanQualify(input))).toBe('NO_THROW');
  });
});
