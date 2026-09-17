import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1D-A — the edit-endpoint half of explicit-clear protection:
// a manual edit records per-field control state so automatic reconcile never
// undoes recruiter intent. (The reconcile-side gate is proven RED-first in
// talent-reconcile/reconcile-plan.spec.) Here: the write on clear/set + the
// release-hold affordance.

const TENANT = '01900000-0000-7000-8000-000000000001';
const EDIT_AUTH = {
  sub: 'me',
  tenant_id: TENANT,
  scopes: ['talent:edit'],
} as unknown as AuthContextType;

function makeController() {
  const update = vi.fn().mockResolvedValue({ id: 'tal-1', first_name: 'Ada' });
  const repo = { update };
  const upsertProfileFieldState = vi.fn().mockResolvedValue(undefined);
  const setProjectionPolicy = vi.fn().mockResolvedValue(undefined);
  const reconcileRepo = {
    upsertProfileFieldState,
    setProjectionPolicy,
    listProfileFieldStates: vi.fn().mockResolvedValue([]),
  };
  const talentExtraction = { replaceDeclaredWorkHistory: vi.fn() };
  const ctl = new TalentRecordController(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    talentExtraction as never,
    {} as never,
    {} as never,
    reconcileRepo as never,
  );
  return { ctl, update, upsertProfileFieldState, setProjectionPolicy };
}

describe('TI-1D-A — edit endpoint writes per-field control state', () => {
  it('explicit clear of a reconcile-covered field → EXPLICITLY_CLEARED + MANUAL + HOLD', async () => {
    const { ctl, upsertProfileFieldState } = makeController();
    await ctl.update(EDIT_AUTH, 'tal-1', { web_site: null } as never, 'rq-1');
    expect(upsertProfileFieldState).toHaveBeenCalledWith({
      tenant_id: TENANT,
      talent_record_id: 'tal-1',
      field_key: 'web_site',
      value_state: 'EXPLICITLY_CLEARED',
      source_type: 'MANUAL',
      projection_policy: 'HOLD',
    });
  });

  it('empty-string clear is also EXPLICITLY_CLEARED + HOLD', async () => {
    const { ctl, upsertProfileFieldState } = makeController();
    await ctl.update(EDIT_AUTH, 'tal-1', { city: '   ' } as never, 'rq-1');
    expect(upsertProfileFieldState).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: 'city', value_state: 'EXPLICITLY_CLEARED', projection_policy: 'HOLD' }),
    );
  });

  it('manual non-empty value → SET + MANUAL + AUTO (accurate state; reconcile still never overwrites occupied)', async () => {
    const { ctl, upsertProfileFieldState } = makeController();
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: 'US_CITIZEN' } as never, 'rq-1');
    expect(upsertProfileFieldState).toHaveBeenCalledWith(
      expect.objectContaining({
        field_key: 'work_authorization',
        value_state: 'SET',
        source_type: 'MANUAL',
        projection_policy: 'AUTO',
      }),
    );
  });

  it('fields ABSENT from the edit body are untouched (no field-state write)', async () => {
    const { ctl, upsertProfileFieldState } = makeController();
    await ctl.update(EDIT_AUTH, 'tal-1', { first_name: 'Grace' } as never, 'rq-1');
    expect(upsertProfileFieldState).not.toHaveBeenCalled();
  });

  it('field_controls on PATCH releases a hold (projection_policy AUTO) via the repo; value_state untouched', async () => {
    const { ctl, setProjectionPolicy } = makeController();
    await ctl.update(
      EDIT_AUTH,
      'tal-1',
      { field_controls: { web_site: { projection_policy: 'AUTO' } } } as never,
      'rq-1',
    );
    expect(setProjectionPolicy).toHaveBeenCalledWith({
      tenant_id: TENANT,
      talent_record_id: 'tal-1',
      field_key: 'web_site',
      projection_policy: 'AUTO',
    });
  });

  it('field_controls with a non-reconcile-covered field → 422 (never mutates)', async () => {
    const { ctl, setProjectionPolicy } = makeController();
    await expect(
      ctl.update(
        EDIT_AUTH,
        'tal-1',
        { field_controls: { first_name: { projection_policy: 'AUTO' } } } as never,
        'rq-1',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
    expect(setProjectionPolicy).not.toHaveBeenCalled();
  });
});
