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

function makeController(opts: { view?: unknown; readModel?: unknown[] } = {}) {
  const update = vi.fn().mockResolvedValue({ id: 'tal-1', first_name: 'Ada' });
  const findById = vi.fn().mockResolvedValue(
    opts.view === undefined
      ? { id: 'tal-1', work_authorization: 'US_CITIZEN', city: 'London', web_site: null }
      : opts.view,
  );
  const repo = { update, findById };
  const upsertProfileFieldState = vi.fn().mockResolvedValue(undefined);
  const setProjectionPolicy = vi.fn().mockResolvedValue(undefined);
  const resolveFieldReview = vi.fn().mockResolvedValue(undefined);
  const getFieldStateReadModel = vi.fn().mockResolvedValue(opts.readModel ?? []);
  const reconcileRepo = {
    upsertProfileFieldState,
    setProjectionPolicy,
    listProfileFieldStates: vi.fn().mockResolvedValue([]),
    resolveFieldReview,
    getFieldStateReadModel,
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
  return { ctl, update, findById, upsertProfileFieldState, setProjectionPolicy, resolveFieldReview, getFieldStateReadModel };
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

// TALENT-INTEL-1 TI-1D-B — the DEDICATED field-state read endpoint (GET
// :id/field-state) and the PATCH resolution fold (a manual edit of a field in
// PENDING_REVIEW resolves it + clears proposed_value; no new resolve route).
describe('TI-1D-B — GET :id/field-state read model', () => {
  it('merges the read model with current_value from the canonical getById projection', async () => {
    const READ = [
      {
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
        resolution_status: 'PENDING_REVIEW',
        resolution_reason: 'EVIDENCE_CONFLICT',
        proposed_value: 'VISA_HOLDER',
        provenance: null,
      },
      {
        field_key: 'city',
        value_state: 'SET',
        source_type: 'RECONCILED',
        projection_policy: 'AUTO',
        resolution_status: 'NONE',
        resolution_reason: null,
        proposed_value: null,
        provenance: { evidence_id: 'ev-city' },
      },
    ];
    const { ctl, getFieldStateReadModel } = makeController({
      view: { id: 'tal-1', work_authorization: null, city: 'London' },
      readModel: READ,
    });

    const res = await ctl.getFieldState(EDIT_AUTH, 'tal-1', 'rq-1');

    expect(getFieldStateReadModel).toHaveBeenCalledWith('tal-1');
    expect(res).toEqual({
      talent_record_id: 'tal-1',
      fields: [
        {
          field_key: 'work_authorization',
          current_value: null, // slot cleared — from getById, NOT the proposed_value
          value_state: 'EXPLICITLY_CLEARED',
          source_type: 'MANUAL',
          projection_policy: 'HOLD',
          provenance: null,
          proposed_value: 'VISA_HOLDER',
          resolution_status: 'PENDING_REVIEW',
          resolution_reason: 'EVIDENCE_CONFLICT',
        },
        {
          field_key: 'city',
          current_value: 'London',
          value_state: 'SET',
          source_type: 'RECONCILED',
          projection_policy: 'AUTO',
          provenance: { evidence_id: 'ev-city' },
          proposed_value: null,
          resolution_status: 'NONE',
          resolution_reason: null,
        },
      ],
    });
  });

  it('404 when the record is not in the tenant', async () => {
    const { ctl } = makeController({ view: null });
    await expect(ctl.getFieldState(EDIT_AUTH, 'missing', 'rq-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

// Gate-6 ruling — the resolution reason keys off the PRE-PATCH incumbent value:
//   PATCH result == proposed_value       → ACCEPTED_PROPOSED
//   PATCH result == pre-PATCH current    → KEPT_CURRENT  (incl. was-null-stays-null)
//   anything else recruiter authors      → MANUAL_CONFIRMATION (incl. clearing a
//                                           previously-populated field)
describe('TI-1D-B — PATCH resolves a PENDING_REVIEW field on manual edit', () => {
  // A pending review on work_authorization; pre-PATCH current is `current` (from
  // the getById projection the controller reads before the scalar PATCH).
  const setup = (current: string | null, proposed: string) =>
    makeController({
      view: { id: 'tal-1', work_authorization: current },
      readModel: [
        {
          field_key: 'work_authorization',
          value_state: current === null ? 'EXPLICITLY_CLEARED' : 'SET',
          source_type: 'MANUAL',
          projection_policy: current === null ? 'HOLD' : 'AUTO',
          resolution_status: 'PENDING_REVIEW',
          resolution_reason: 'EVIDENCE_CONFLICT',
          proposed_value: proposed,
          provenance: null,
        },
      ],
    });

  it('result EQUALS proposed_value (differs from incumbent) → ACCEPTED_PROPOSED', async () => {
    const { ctl, resolveFieldReview } = setup('VISA_HOLDER', 'US_CITIZEN');
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: 'US_CITIZEN' } as never, 'rq-1');
    expect(resolveFieldReview).toHaveBeenCalledWith({
      tenant_id: TENANT,
      talent_record_id: 'tal-1',
      field_key: 'work_authorization',
      resolution_reason: 'ACCEPTED_PROPOSED',
    });
  });

  it('result EQUALS the pre-PATCH incumbent (re-save) → KEPT_CURRENT', async () => {
    const { ctl, resolveFieldReview } = setup('VISA_HOLDER', 'US_CITIZEN');
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: 'VISA_HOLDER' } as never, 'rq-1');
    expect(resolveFieldReview).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: 'work_authorization', resolution_reason: 'KEPT_CURRENT' }),
    );
  });

  it('result is a THIRD value (neither proposed nor incumbent) → MANUAL_CONFIRMATION', async () => {
    const { ctl, resolveFieldReview } = setup('VISA_HOLDER', 'US_CITIZEN');
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: 'GREEN_CARD' } as never, 'rq-1');
    expect(resolveFieldReview).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: 'work_authorization', resolution_reason: 'MANUAL_CONFIRMATION' }),
    );
  });

  it('explicit CLEAR of a previously-populated field → MANUAL_CONFIRMATION', async () => {
    const { ctl, resolveFieldReview } = setup('VISA_HOLDER', 'US_CITIZEN');
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: null } as never, 'rq-1');
    expect(resolveFieldReview).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: 'work_authorization', resolution_reason: 'MANUAL_CONFIRMATION' }),
    );
  });

  it('field already null/cleared and remains so → KEPT_CURRENT', async () => {
    const { ctl, resolveFieldReview } = setup(null, 'US_CITIZEN');
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: null } as never, 'rq-1');
    expect(resolveFieldReview).toHaveBeenCalledWith(
      expect.objectContaining({ field_key: 'work_authorization', resolution_reason: 'KEPT_CURRENT' }),
    );
  });

  it('editing a field NOT in PENDING_REVIEW does not resolve', async () => {
    const { ctl, resolveFieldReview } = makeController({
      view: { id: 'tal-1', work_authorization: 'US_CITIZEN' },
      readModel: [
        {
          field_key: 'work_authorization',
          value_state: 'SET',
          source_type: 'MANUAL',
          projection_policy: 'AUTO',
          resolution_status: 'NONE',
          resolution_reason: null,
          proposed_value: null,
          provenance: null,
        },
      ],
    });
    await ctl.update(EDIT_AUTH, 'tal-1', { work_authorization: 'CANADA_PR' } as never, 'rq-1');
    expect(resolveFieldReview).not.toHaveBeenCalled();
  });
});
