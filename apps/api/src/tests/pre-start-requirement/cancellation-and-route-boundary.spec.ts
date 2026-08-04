import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PreStartCancellationService } from '../../pre-start-requirement/pre-start-cancellation.service.js';

// Track 3 / E2 v1.2.2 — §14 A2-C (governed cancellation, no user endpoint) + §13-R
// (reopen is its own :reopen-scoped route, out of :act).

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const PLACEMENT = '00000000-0000-0000-0000-0000000000bb';

function inst(id: string, status: string, blocking = true) {
  return { id, tenant_id: TENANT, placement_process_id: PLACEMENT, blocking, status };
}

describe('§14 A2-C — governed cancellation (no user action)', () => {
  it('cancels only UNRESOLVED instances (system actor), skips resolved ones', async () => {
    const applyStatusMove = vi.fn().mockImplementation(async (i) => ({ ...i, status: 'CANCELED' }));
    const repo = {
      findByPlacement: vi.fn().mockResolvedValue([
        inst('i1', 'PENDING'),
        inst('i2', 'IN_PROGRESS'),
        inst('i3', 'FAILED'),
        inst('i4', 'SATISFIED'), // resolved — must be skipped
        inst('i5', 'WAIVED'), // resolved — must be skipped
        inst('i6', 'CANCELED'), // already terminal — skipped
      ]),
      applyStatusMove,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PreStartCancellationService(repo as any);
    const cancelled = await svc.cancelForTerminalPlacement(TENANT, PLACEMENT, 'placement fell through', 'sys', 'r');

    expect(cancelled).toHaveLength(3); // i1, i2, i3
    const targets = applyStatusMove.mock.calls.map((c) => c[0]);
    expect(targets.every((t) => t.to === 'CANCELED')).toBe(true);
    expect(targets.every((t) => t.actor_type === 'system')).toBe(true);
    expect(new Set(targets.map((t) => t.requirement_instance_id))).toEqual(new Set(['i1', 'i2', 'i3']));
  });
});

describe('route boundaries (structural)', () => {
  const controller = readFileSync(
    resolve(__dirname, '..', '..', 'pre-start-requirement', 'pre-start-requirement.controller.ts'),
    'utf8',
  );
  const dto = readFileSync(
    resolve(__dirname, '..', '..', 'pre-start-requirement', 'dto', 'pre-start-requirement.dto.ts'),
    'utf8',
  );

  it('the controller exposes NO cancel route', () => {
    expect(controller).not.toMatch(/cancel/i);
    expect(controller).not.toMatch(/CANCELED/);
  });

  it('reopen is its own route gated by pre_start_requirement:reopen', () => {
    expect(controller).toMatch(/@Post\('requirements\/:instanceId\/reopen'\)/);
    expect(controller).toMatch(/@RequireScopes\('pre_start_requirement:reopen'\)/);
  });

  it("the :act status route excludes reopen (PENDING) and CANCELED", () => {
    // STATUS_MOVE_TARGETS is the closed set the :act route accepts.
    const m = /STATUS_MOVE_TARGETS = \[([^\]]*)\]/.exec(dto);
    expect(m).not.toBeNull();
    const targets = m![1];
    expect(targets).not.toMatch(/PENDING/);
    expect(targets).not.toMatch(/CANCELED/);
    expect(targets).toMatch(/IN_PROGRESS/);
    expect(targets).toMatch(/SATISFIED/);
    expect(targets).toMatch(/FAILED/);
  });
});
