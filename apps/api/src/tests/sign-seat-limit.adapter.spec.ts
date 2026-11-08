import type { SeatLimitTx } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { SignSeatLimitAdapter } from '../billing/sign-seat-limit.adapter.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2.3 — the apps/api
// SeatLimitPort: the purchased seats from libs/subscription, the S-4 count from the caller's identity
// transaction. Not per seat → not limited (every existing tenant).

describe('SignSeatLimitAdapter (apps/api)', () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ n: 2 }]) } as unknown as SeatLimitTx;
  it('limited: purchased from the Sign subscription, used counted in the transaction', async () => {
    const seats = { seatLimit: vi.fn().mockResolvedValue(3) };
    expect(await new SignSeatLimitAdapter(seats as never).check('t-1', tx)).toEqual({ limited: true, used: 2, purchased: 3 });
    expect(seats.seatLimit).toHaveBeenCalledWith('t-1', 'sign');
  });
  it('not limited without a per-seat subscription (no count is read)', async () => {
    const q = vi.fn();
    expect(await new SignSeatLimitAdapter({ seatLimit: vi.fn().mockResolvedValue(null) } as never).check('t-1', { $queryRaw: q } as unknown as SeatLimitTx)).toEqual({ limited: false });
    expect(q).not.toHaveBeenCalled();
  });
});
