import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { messageForAddEdgeError } from './error-messages';

// Settings S5c-1 — edge-rejection mapper tests.
//
// PL-94 §2 ruling 4: real rejections are self_loop + cycle ONLY.
// Duplicates are silent successes — they NEVER reach this mapper at
// all (the BE returns 201 with the existing edge).

describe('messageForAddEdgeError — the self_loop + cycle templates (ruling 4)', () => {
  it('maps self_loop to a "user can’t manage themselves" message', () => {
    const err = new ApiError(409, 'self', 'MANAGEMENT_CYCLE_REJECTED', {
      reason: 'self_loop',
      manager_user_id: 'u-a',
      report_user_id: 'u-a',
    });
    const msg = messageForAddEdgeError(err);
    expect(msg.title).toMatch(/can.t manage themselves/i);
    expect(msg.detail).toMatch(/two different people/i);
  });

  it('maps cycle to a "reporting cycle" message naming the chain context', () => {
    const err = new ApiError(409, 'cycle', 'MANAGEMENT_CYCLE_REJECTED', {
      reason: 'cycle',
      manager_user_id: 'u-a',
      report_user_id: 'u-b',
    });
    const msg = messageForAddEdgeError(err);
    expect(msg.title).toMatch(/reporting cycle/i);
    expect(msg.detail).toMatch(/already a manager up this/i);
  });

  it('falls back to the BE message for an unknown reason', () => {
    const err = new ApiError(400, 'somethingelse', 'VALIDATION_ERROR', {
      reason: 'foo',
    });
    const msg = messageForAddEdgeError(err);
    expect(msg.title).toBe('somethingelse');
  });

  it('maps 404 to a "user doesn’t exist" message (the UUID-fallback path)', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    const msg = messageForAddEdgeError(err);
    expect(msg.title).toMatch(/doesn.t exist in your tenant/i);
  });

  it('handles non-ApiError throwables gracefully', () => {
    const err = new Error('network');
    const msg = messageForAddEdgeError(err);
    expect(msg.title).toMatch(/unexpected error/i);
  });
});
