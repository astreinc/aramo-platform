import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// Add-Talent create — reviewed work-history persists as declared
// TalentWorkHistoryEntry AFTER the record exists (LOCKED scope expansion).
// Best-effort: a persist hiccup must NOT fail the create.

const TENANT = '01900000-0000-7000-8000-000000000001';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:create'] } as unknown as AuthContextType;

function makeController(opts: { persistThrows?: boolean } = {}) {
  const create = vi.fn().mockResolvedValue({ id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' });
  const findActiveByEmail = vi.fn().mockResolvedValue(null);
  const repo = { create, findActiveByEmail };
  const persistDeclaredWorkHistory = opts.persistThrows
    ? vi.fn().mockRejectedValue(new Error('evidence write failed'))
    : vi.fn().mockResolvedValue(['wh-1']);
  const talentExtraction = { persistDeclaredWorkHistory };
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
  return { ctl, create, persistDeclaredWorkHistory };
}

const BODY = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email1: 'ada@example.com',
  phone_cell: '555-0100',
  work_history: [
    { employer_name: 'Northstar', role_title: 'Cloud Engineer', start_date: '2022', end_date: 'present' },
  ],
};

describe('create — work-history persistence', () => {
  it('persists reviewed work-history after the record is created', async () => {
    const { ctl, create, persistDeclaredWorkHistory } = makeController();
    const res = await ctl.create(AUTH, BODY as never, 'rq-1');
    expect(res.id).toBe('tal-new');
    expect(create).toHaveBeenCalledOnce();
    expect(persistDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-new',
      tenant_id: TENANT,
      entries: BODY.work_history,
    });
  });

  it('a work-history persist error does NOT fail the create (best-effort)', async () => {
    const { ctl } = makeController({ persistThrows: true });
    const res = await ctl.create(AUTH, BODY as never, 'rq-1');
    expect(res.id).toBe('tal-new'); // record still created
  });

  it('no work_history → persist is not called', async () => {
    const { ctl, persistDeclaredWorkHistory } = makeController();
    const body = { first_name: 'Ada', last_name: 'Lovelace', email1: 'a@x.com', phone_cell: '555-0100' };
    await ctl.create(AUTH, body as never, 'rq-1');
    expect(persistDeclaredWorkHistory).not.toHaveBeenCalled();
  });
});
