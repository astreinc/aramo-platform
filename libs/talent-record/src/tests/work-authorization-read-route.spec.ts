import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1G §3 — GET :id/work-authorization: the deterministic current
// state + the append-only assertion history, projected to the recruiter contract.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:read'] } as unknown as AuthContextType;

function waRow(over: Record<string, unknown> = {}) {
  return {
    id: 'wa-1', talent_id: TALENT, tenant_id: TENANT,
    work_authorization_status: 'VISA_HOLDER',
    authorized_to_work_in: [], visa_type: null, requires_sponsorship: false,
    updated_at: new Date('2026-01-01T00:00:00Z'),
    asserted_at: new Date('2026-01-01T00:00:00Z'),
    effective_from: null, effective_to: null, expires_at: null,
    ...over,
  };
}

function make(parts: { talent?: unknown; state?: unknown } = {}) {
  const findById = vi.fn().mockResolvedValue(parts.talent === undefined ? { id: TALENT } : parts.talent);
  const getWorkAuthorizationHistory = vi.fn().mockResolvedValue(
    parts.state ?? { current: waRow(), history: [waRow()] },
  );
  const ctl = new TalentRecordController(
    { findById } as never, {} as never, {} as never, {} as never,
    { getWorkAuthorizationHistory } as never, {} as never, {} as never,
    undefined, {} as never, {} as never, {} as never, undefined,
  );
  return { ctl, findById, getWorkAuthorizationHistory };
}

describe('TI-1G §3 — GET :id/work-authorization', () => {
  it('returns the current projection + full history (ISO-mapped)', async () => {
    const { ctl } = make({
      state: {
        current: waRow({ work_authorization_status: 'PERMANENT_RESIDENT', asserted_at: new Date('2026-03-01T00:00:00Z') }),
        history: [
          waRow({ id: 'wa-2', work_authorization_status: 'PERMANENT_RESIDENT', asserted_at: new Date('2026-03-01T00:00:00Z') }),
          waRow({ id: 'wa-1', work_authorization_status: 'VISA_HOLDER', asserted_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-02-15') }),
        ],
      },
    });
    const res = await ctl.getWorkAuthorizationState(AUTH, TALENT, 'rq-1');
    expect(res.talent_id).toBe(TALENT);
    expect(res.current?.work_authorization_status).toBe('PERMANENT_RESIDENT');
    expect(res.current?.asserted_at).toBe('2026-03-01T00:00:00.000Z');
    expect(res.history).toHaveLength(2);
    // date-only projection for the expiring visa assertion
    expect(res.history[1]?.expires_at).toBe('2026-02-15');
    expect(res.history[1]?.effective_from).toBeNull();
  });

  it('returns current=null when no work-auth assertion exists (history empty)', async () => {
    const { ctl } = make({ state: { current: null, history: [] } });
    const res = await ctl.getWorkAuthorizationState(AUTH, TALENT, 'rq-1');
    expect(res.current).toBeNull();
    expect(res.history).toEqual([]);
  });

  it('404 when the talent is not in the tenant', async () => {
    const { ctl, getWorkAuthorizationHistory } = make({ talent: null });
    await expect(ctl.getWorkAuthorizationState(AUTH, 'missing', 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(getWorkAuthorizationHistory).not.toHaveBeenCalled();
  });
});
