import { describe, expect, it, vi } from 'vitest';

import {
  MAX_MATERIALIZE_ATTEMPTS,
  PreStartMaterializationService,
} from '../../pre-start-requirement/pre-start-materialization.service.js';

// Track 3 / E2 — reconciler / materialize give-up policy (unit-level, mocked
// repositories). A reconciler that retries forever is a silent backlog; a config
// failure is not transient. Fail-closed + VISIBLE, never silently ready.

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const PLACEMENT = '00000000-0000-0000-0000-0000000000bb';

function makeService(opts: {
  intentAttempts?: number;
  intentStatus?: 'pending' | 'resolved' | 'quarantined';
  resolveEffective?: unknown;
  materializeImpl?: () => Promise<unknown>;
}) {
  const intent = {
    id: 'intent-1',
    tenant_id: TENANT,
    placement_process_id: PLACEMENT,
    scope: 'TENANT',
    scope_ref_id: TENANT,
    status: opts.intentStatus ?? 'pending',
    attempts: opts.intentAttempts ?? 0,
  };
  const intents = {
    ensureIntent: vi.fn().mockResolvedValue(intent),
    recordAttempt: vi.fn().mockResolvedValue(intent),
    markResolved: vi.fn().mockResolvedValue(intent),
    markQuarantined: vi.fn().mockResolvedValue(intent),
    listPending: vi.fn().mockResolvedValue([intent]),
  };
  const sets = { resolveEffective: vi.fn().mockResolvedValue(opts.resolveEffective ?? null) };
  const requirements = {
    materialize: opts.materializeImpl ? vi.fn(opts.materializeImpl) : vi.fn().mockResolvedValue([]),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PreStartMaterializationService(sets as any, requirements as any, intents as any);
  return { svc, intents, sets, requirements };
}

const input = { tenant_id: TENANT, placement_process_id: PLACEMENT, scope: 'TENANT' as const, scope_ref_id: TENANT, client_id: null, requisition_id: null };

describe('PreStartMaterializationService — resolve / quarantine policy', () => {
  it('config failure (no published set) QUARANTINES immediately, no retry burn', async () => {
    const { svc, intents } = makeService({ resolveEffective: null });
    await svc.materializeForPlacement(input);
    expect(intents.markQuarantined).toHaveBeenCalledOnce();
    expect(intents.markQuarantined.mock.calls[0]![1]).toBe('no_published_definition_set');
    expect(intents.markResolved).not.toHaveBeenCalled();
  });

  it('success MARKS RESOLVED', async () => {
    const set = { id: 's1', version: 'v1', checksum: 'c', definitions: [] };
    const { svc, intents } = makeService({ resolveEffective: set });
    await svc.materializeForPlacement(input);
    expect(intents.markResolved).toHaveBeenCalledOnce();
    expect(intents.markQuarantined).not.toHaveBeenCalled();
  });

  it('transient failure below the cap STAYS PENDING (no quarantine)', async () => {
    const set = { id: 's1', version: 'v1', checksum: 'c', definitions: [] };
    const { svc, intents } = makeService({
      resolveEffective: set,
      intentAttempts: 0,
      materializeImpl: () => Promise.reject(new Error('db blip')),
    });
    await svc.materializeForPlacement(input);
    expect(intents.markQuarantined).not.toHaveBeenCalled();
    expect(intents.markResolved).not.toHaveBeenCalled();
  });

  it(`transient failure at the cap (${MAX_MATERIALIZE_ATTEMPTS}) QUARANTINES`, async () => {
    const set = { id: 's1', version: 'v1', checksum: 'c', definitions: [] };
    const { svc, intents } = makeService({
      resolveEffective: set,
      intentAttempts: MAX_MATERIALIZE_ATTEMPTS - 1,
      materializeImpl: () => Promise.reject(new Error('db blip')),
    });
    await svc.materializeForPlacement(input);
    expect(intents.markQuarantined).toHaveBeenCalledOnce();
    expect(intents.markQuarantined.mock.calls[0]![1]).toContain('max_attempts_exceeded');
  });

  it('a terminal (resolved/quarantined) intent is NOT re-attempted', async () => {
    const { svc, sets } = makeService({ intentStatus: 'quarantined' });
    await svc.materializeForPlacement(input);
    expect(sets.resolveEffective).not.toHaveBeenCalled();
  });
});
