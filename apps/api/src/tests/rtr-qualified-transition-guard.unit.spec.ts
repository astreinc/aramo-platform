import { describe, expect, it, vi } from 'vitest';

import { RtrQualifiedTransitionGuard } from '../rtr/rtr-qualified-transition-guard.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root guard that joins the
// Pipeline `qualified` milestone to the ONE RTR readiness predicate (ADR-0029 wall).
//
// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.3–§4.5: the guard runs on the Pipeline
// transition's OWN transaction — beginQualifyInTx takes the SHARED client-submittal-policy
// lock; assertCanQualifyInTx reads the linearization instant, resolves the requirement at
// it (DocumentReadinessGate.assessInTx) and returns the applied decision for the audit.
// UNRESOLVED → PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED; REQUIRED + not executed →
// PIPELINE_QUALIFY_REQUIRES_RTR (both 422).

const T_L = new Date('2026-10-20T12:00:00.000Z');

function makeTx() {
  const calls: string[] = [];
  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('clock_timestamp')) return [{ t: T_L }];
      return [{ locked: '' }];
    }),
  };
  return { tx, calls };
}

function policy(disposition: 'REQUIRED' | 'NOT_REQUIRED' | 'UNRESOLVED', unresolved_reason?: 'NO_LAYER' | 'NO_KEY') {
  return {
    disposition,
    ...(unresolved_reason === undefined ? {} : { unresolved_reason }),
    source: disposition === 'UNRESOLVED' ? null : 'CLIENT_OVERRIDE',
    scope_ref: disposition === 'UNRESOLVED' ? null : 'co-1',
    version: disposition === 'UNRESOLVED' ? null : '2.0.0',
    checksum: disposition === 'UNRESOLVED' ? null : 'abc',
    composite_version: disposition === 'UNRESOLVED' ? null : 'TENANT:1:x|CLIENT:2:y',
    resolved_at: T_L.toISOString(),
  };
}

function makeGuard(verdict: { satisfied: boolean; deny: string | null }, p: ReturnType<typeof policy>) {
  const readiness = { assessInTx: vi.fn(async () => ({ verdict, policy: p })) };
  return { guard: new RtrQualifiedTransitionGuard(readiness as never), readiness };
}

const input = { tenant_id: 't1', talent_id: 'tal-1', requisition_id: 'req-1', requestId: 'r' };

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'NO_THROW',
    (e) => (e as { code?: string }).code ?? 'NO_CODE',
  );
}

describe('RtrQualifiedTransitionGuard (§29-32; v1.2 §4.3–§4.5)', () => {
  it('beginQualifyInTx takes the SHARED per-tenant client-submittal-policy advisory lock', async () => {
    const { tx, calls } = makeTx();
    const { guard } = makeGuard({ satisfied: true, deny: null }, policy('NOT_REQUIRED'));
    await guard.beginQualifyInTx(tx, { tenant_id: 't1' });
    expect(calls[0]).toContain('pg_advisory_xact_lock_shared');
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("'csp:'"), 't1');
  });

  it('resolves at the database-clock linearization instant read on the SAME tx', async () => {
    const { tx } = makeTx();
    const { guard, readiness } = makeGuard({ satisfied: true, deny: null }, policy('NOT_REQUIRED'));
    await guard.assertCanQualifyInTx(tx, input);
    expect(readiness.assessInTx).toHaveBeenCalledWith(tx, {
      tenant_id: 't1',
      talent_id: 'tal-1',
      requisition_id: 'req-1',
      at: T_L,
    });
  });

  it('RTR not required → allowed; returns the applied decision (source/version/checksum/t_L)', async () => {
    const { tx } = makeTx();
    const { guard } = makeGuard({ satisfied: true, deny: null }, policy('NOT_REQUIRED'));
    const d = await guard.assertCanQualifyInTx(tx, input);
    expect(d).toEqual({
      disposition: 'NOT_REQUIRED',
      source: 'CLIENT_OVERRIDE',
      scope_ref: 'co-1',
      version: '2.0.0',
      checksum: 'abc',
      composite_version: 'TENANT:1:x|CLIENT:2:y',
      resolved_at: T_L.toISOString(),
    });
  });

  it('RTR required + executed → allowed (no throw)', async () => {
    const { tx } = makeTx();
    const { guard } = makeGuard({ satisfied: true, deny: null }, policy('REQUIRED'));
    expect(await codeOf(guard.assertCanQualifyInTx(tx, input))).toBe('NO_THROW');
  });

  it('RTR required + NOT executed → refuse with PIPELINE_QUALIFY_REQUIRES_RTR (422)', async () => {
    const { tx } = makeTx();
    const { guard } = makeGuard({ satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' }, policy('REQUIRED'));
    const err = await guard.assertCanQualifyInTx(tx, input).catch((e) => e);
    expect((err as { code?: string }).code).toBe('PIPELINE_QUALIFY_REQUIRES_RTR');
    expect((err as { statusCode?: number }).statusCode).toBe(422);
  });

  it('UNRESOLVED (no layer) → PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED (422), never ungated', async () => {
    const { tx } = makeTx();
    const { guard } = makeGuard(
      { satisfied: false, deny: 'SUBMITTAL_RTR_POLICY_UNRESOLVED' },
      policy('UNRESOLVED', 'NO_LAYER'),
    );
    const err = await guard.assertCanQualifyInTx(tx, input).catch((e) => e);
    expect((err as { code?: string }).code).toBe('PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED');
    expect((err as { statusCode?: number }).statusCode).toBe(422);
    expect((err as { context?: { details?: { reason?: string } } }).context?.details?.reason).toBe('no_policy_layer');
  });

  it('UNRESOLVED (policy without rtr_present) → refused with reason rtr_requirement_not_declared', async () => {
    const { tx } = makeTx();
    const { guard } = makeGuard(
      { satisfied: false, deny: 'SUBMITTAL_RTR_POLICY_UNRESOLVED' },
      policy('UNRESOLVED', 'NO_KEY'),
    );
    const err = await guard.assertCanQualifyInTx(tx, input).catch((e) => e);
    expect((err as { context?: { details?: { reason?: string } } }).context?.details?.reason).toBe('rtr_requirement_not_declared');
  });
});
