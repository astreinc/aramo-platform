import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// Full-profile EDIT (LOCKED scope expansion) — PATCH /v1/talent-records/:id with
// a work_history array REPLACES the talent's declared work-history (replace-set).
// Unlike the create path's best-effort persist, an edit failure PROPAGATES (the
// recruiter explicitly edited these rows). ABSENT work_history = scalar-only PATCH.

const TENANT = '01900000-0000-7000-8000-000000000001';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:edit'] } as unknown as AuthContextType;

function makeController(opts: { replaceThrows?: boolean } = {}) {
  const update = vi.fn().mockResolvedValue({ id: 'tal-1', first_name: 'Ada', last_name: 'Lovelace' });
  const repo = { update };
  const replaceDeclaredWorkHistory = opts.replaceThrows
    ? vi.fn().mockRejectedValue(new Error('evidence replace failed'))
    : vi.fn().mockResolvedValue(['wh-1']);
  const talentExtraction = { replaceDeclaredWorkHistory };
  const ctl = new TalentRecordController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    talentExtraction as any,
  );
  return { ctl, update, replaceDeclaredWorkHistory };
}

describe('update — work-history replace-set', () => {
  it('replaces declared work-history when the edit carries a work_history array', async () => {
    const { ctl, update, replaceDeclaredWorkHistory } = makeController();
    const entries = [
      { employer_name: 'Northstar', role_title: 'Cloud Engineer', start_date: '2022', end_date: 'present' },
    ];
    const res = await ctl.update(AUTH, 'tal-1', { title: 'Senior Engineer', work_history: entries } as never, 'rq-1');
    expect(res.id).toBe('tal-1');
    expect(update).toHaveBeenCalledOnce();
    expect(replaceDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-1',
      tenant_id: TENANT,
      entries,
    });
  });

  it('an empty work_history array clears the declared work-history (replace with [])', async () => {
    const { ctl, replaceDeclaredWorkHistory } = makeController();
    await ctl.update(AUTH, 'tal-1', { work_history: [] } as never, 'rq-1');
    expect(replaceDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-1',
      tenant_id: TENANT,
      entries: [],
    });
  });

  it('ABSENT work_history → scalar-only PATCH; replace is not called', async () => {
    const { ctl, update, replaceDeclaredWorkHistory } = makeController();
    await ctl.update(AUTH, 'tal-1', { title: 'Senior Engineer' } as never, 'rq-1');
    expect(update).toHaveBeenCalledOnce();
    expect(replaceDeclaredWorkHistory).not.toHaveBeenCalled();
  });

  it('a work-history replace error PROPAGATES (NOT best-effort — unlike create)', async () => {
    const { ctl } = makeController({ replaceThrows: true });
    await expect(
      ctl.update(AUTH, 'tal-1', { work_history: [{ employer_name: 'X', role_title: 'Y' }] } as never, 'rq-1'),
    ).rejects.toThrow('evidence replace failed');
  });
});
