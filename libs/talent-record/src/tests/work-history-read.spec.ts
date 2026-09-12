import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// GET /v1/talent-records/:id/work-history — the Talent-detail read (LOCKED scope
// expansion). Delegates to the already-injected TalentExtractionService and
// returns { work_history }. Rows are declared (verified:false 'from resume').

const AUTH = {
  sub: 'me',
  tenant_id: '01900000-0000-7000-8000-000000000001',
  scopes: ['talent:read'],
} as unknown as AuthContextType;

describe('GET :id/work-history', () => {
  it('returns the declared work-history for the talent, tenant-scoped', async () => {
    const rows = [
      {
        id: 'wh-1',
        employer_name: 'Northline Systems',
        role_title: 'Sr. Cloud Engineer',
        start_date: '2022-01-01',
        end_date: null,
        employment_type: null,
        description: 'Leads a platform team.',
        source: 'resume',
        verified: false,
      },
    ];
    const listDeclaredWorkHistory = vi.fn().mockResolvedValue(rows);
    const ctl = new TalentRecordController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { listDeclaredWorkHistory } as any,
    );
    const res = await ctl.workHistory(AUTH, 'tal-1');
    expect(res).toEqual({ work_history: rows });
    expect(listDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-1',
      tenant_id: AUTH.tenant_id,
    });
  });
});
