import { describe, expect, it, vi } from 'vitest';

import { TalentReconcileService } from '../lib/talent-reconcile.service.js';

// Unit coverage for the reconcile orchestration (the pure plan is covered in
// reconcile-plan.spec). Stubs the three collaborators; proves apply order,
// watermark-last, record-gone, and transient-retry.

const CAND = {
  subject_id: 'subj-1',
  tenant_id: 'ten-1',
  talent_record_id: 'rec-1',
};

function make(parts: {
  record?: unknown;
  evidence?: unknown[];
  applyThrows?: boolean;
} = {}) {
  const findById = vi.fn().mockResolvedValue(
    parts.record === undefined
      ? { first_name: 'Alan', last_name: 'Turing', email1: null, phone_cell: null, web_site: null, address: null, address2: null, city: null, state: null, zip: null, key_skills: null }
      : parts.record,
  );
  const getEvidence = vi.fn().mockResolvedValue(parts.evidence ?? [
    { id: 'e1', assertion_type: 'EMAIL', assertion_payload: { normalized_value: 'a@x.com' }, current_status: 'VALID', collected_at: new Date('2026-07-04'), created_at: new Date('2026-07-04') },
  ]);
  const markReconciled = vi.fn().mockResolvedValue(undefined);
  const bumpReconcileAttempt = vi.fn().mockResolvedValue(undefined);
  const trust = { getEvidence, markReconciled, bumpReconcileAttempt } as never;

  const talentRecords = { findById } as never;

  const applyEnrichment = parts.applyThrows
    ? vi.fn().mockRejectedValue(new Error('db down'))
    : vi.fn().mockResolvedValue(undefined);
  const upsertFieldProvenance = vi.fn().mockResolvedValue(undefined);
  const recordPendingContradiction = vi.fn().mockResolvedValue(undefined);
  const reconcileRepo = { applyEnrichment, upsertFieldProvenance, recordPendingContradiction } as never;

  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const service = new TalentReconcileService(trust, talentRecords, reconcileRepo, logger);
  return { service, findById, getEvidence, markReconciled, bumpReconcileAttempt, applyEnrichment, upsertFieldProvenance, recordPendingContradiction };
}

describe('TalentReconcileService.reconcileSubject', () => {
  it('reconciled: enriches null slot, writes provenance, stamps watermark last', async () => {
    const { service, applyEnrichment, upsertFieldProvenance, markReconciled, bumpReconcileAttempt } = make();
    const result = await service.reconcileSubject(CAND);

    expect(result.outcome).toBe('reconciled');
    expect(result.fields_filled).toBe(1);
    expect(applyEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'ten-1', talent_record_id: 'rec-1', patch: { email1: 'a@x.com' } }),
    );
    expect(upsertFieldProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ field_name: 'email1', evidence_id: 'e1' }),
    );
    expect(markReconciled).toHaveBeenCalledWith('subj-1');
    expect(bumpReconcileAttempt).not.toHaveBeenCalled();
  });

  it('records a pending contradiction for occupied+differing, does not overwrite', async () => {
    const { service, applyEnrichment, recordPendingContradiction, markReconciled } = make({
      record: { first_name: 'Alan', last_name: 'Turing', email1: 'old@x.com', phone_cell: null, web_site: null, address: null, address2: null, city: null, state: null, zip: null, key_skills: null },
      evidence: [{ id: 'e2', assertion_type: 'EMAIL', assertion_payload: { normalized_value: 'new@x.com' }, current_status: 'VALID', collected_at: new Date('2026-07-04'), created_at: new Date('2026-07-04') }],
    });
    const result = await service.reconcileSubject(CAND);

    expect(result.outcome).toBe('reconciled');
    expect(result.contradictions_recorded).toBe(1);
    expect(applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ patch: {} }));
    expect(recordPendingContradiction).toHaveBeenCalledWith(
      expect.objectContaining({ field_name: 'email1', new_evidence_id: 'e2' }),
    );
    expect(markReconciled).toHaveBeenCalledWith('subj-1');
  });

  it('record_gone: linked record deleted → stamp watermark, no enrich', async () => {
    const { service, applyEnrichment, markReconciled } = make({ record: null });
    const result = await service.reconcileSubject(CAND);
    expect(result.outcome).toBe('record_gone');
    expect(applyEnrichment).not.toHaveBeenCalled();
    expect(markReconciled).toHaveBeenCalledWith('subj-1');
  });

  it('transient_retry: a write failure bumps the attempt and leaves the watermark un-advanced', async () => {
    const { service, markReconciled, bumpReconcileAttempt } = make({ applyThrows: true });
    const result = await service.reconcileSubject(CAND);
    expect(result.outcome).toBe('transient_retry');
    expect(bumpReconcileAttempt).toHaveBeenCalledWith('subj-1');
    expect(markReconciled).not.toHaveBeenCalled();
  });

  it('never throws — a failure resolves to a counted outcome', async () => {
    const { service } = make({ applyThrows: true });
    await expect(service.reconcileSubject(CAND)).resolves.toMatchObject({ outcome: 'transient_retry' });
  });
});
