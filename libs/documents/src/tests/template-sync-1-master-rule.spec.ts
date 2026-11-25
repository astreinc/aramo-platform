import { describe, expect, it } from 'vitest';

import { masterAvailable, masterIsNewer, templateMasterView, type TemplateMasterRow } from '../lib/template-master.js';

// TEMPLATE-SYNC-1 (Directive v1.0 LOCKED) §5 test 1 — the one server rule (S-3): newer_available
// for the adopt-time, after-update, own-edits and kept states; withdrawn; not adopted (no master
// object: the rule is only computed for adopted copies); the master deleted.

const NOW = new Date('2026-11-25T12:00:00.000Z');
const master = (over: Partial<TemplateMasterRow> = {}): TemplateMasterRow => ({
  id: 'master-1',
  name: 'Mutual NDA',
  status: 'ACTIVE',
  current_version_id: 'mv2',
  withdraw_notice_at: null,
  withdraw_effective_at: null,
  ...over,
});
const view = (over: Partial<Parameters<typeof templateMasterView>[0]> = {}) =>
  templateMasterView({
    master_template_id: 'master-1',
    master: master(),
    master_current_version_number: 2,
    based_on_version_number: 1,
    kept_version_id: null,
    now: NOW,
    ...over,
  });

describe('TEMPLATE-SYNC-1 S-3 — the master rule', () => {
  it('adopt-time: the copy is based on the current master version, so nothing is newer', () => {
    const v = view({ master_current_version_number: 1, based_on_version_number: 1 });
    expect(v.newer_available).toBe(false);
    expect(v).toMatchObject({ template_id: 'master-1', name: 'Mutual NDA', current_version_id: 'mv2', current_version_number: 1, based_on_version_number: 1, withdrawn: null, kept: false });
  });

  it('a newer master version is published: newer_available', () => {
    expect(view().newer_available).toBe(true);
  });

  it('after the company updated from the new master (based on v2): nothing is newer', () => {
    expect(view({ based_on_version_number: 2 }).newer_available).toBe(false);
  });

  it("the company's own edits keep the version they were copied from: still newer while the master moved", () => {
    // Own edits carry based_on (v1) — the rule only sees the based-on number.
    expect(view({ based_on_version_number: 1 }).newer_available).toBe(true);
  });

  it('kept: hidden for that master version only; a later master version shows it again', () => {
    const kept = view({ kept_version_id: 'mv2' });
    expect(kept.kept).toBe(true);
    expect(kept.newer_available).toBe(false);
    const later = view({ kept_version_id: 'mv2', master: master({ current_version_id: 'mv3' }), master_current_version_number: 3 });
    expect(later.kept).toBe(false);
    expect(later.newer_available).toBe(true);
  });

  it('withdrawn: PENDING before the effective date, IN_EFFECT from it', () => {
    const pending = view({ master: master({ withdraw_notice_at: new Date('2026-11-20T00:00:00Z'), withdraw_effective_at: new Date('2026-12-20T00:00:00Z') }) });
    expect(pending.withdrawn).toEqual({ notice_at: '2026-11-20T00:00:00.000Z', effective_at: '2026-12-20T00:00:00.000Z', status: 'PENDING' });
    const inEffect = view({ master: master({ withdraw_notice_at: new Date('2026-10-20T00:00:00Z'), withdraw_effective_at: new Date('2026-11-20T00:00:00Z') }) });
    expect(inEffect.withdrawn?.status).toBe('IN_EFFECT');
  });

  it('the master deleted: no newer version, no name, nothing to start a draft from', () => {
    const v = view({ master: null, master_current_version_number: null });
    expect(v).toEqual({
      template_id: 'master-1',
      name: null,
      current_version_id: null,
      current_version_number: null,
      based_on_version_number: 1,
      newer_available: false,
      withdrawn: null,
      kept: false,
    });
    expect(masterAvailable(null, NOW)).toBe(false);
  });

  it('an unknown based-on number never reports a newer version', () => {
    expect(masterIsNewer(3, null)).toBe(false);
    expect(masterIsNewer(null, 1)).toBe(false);
    expect(masterIsNewer(2, 1)).toBe(true);
  });

  it('masterAvailable: published and not withdrawn in effect', () => {
    expect(masterAvailable(master(), NOW)).toBe(true);
    expect(masterAvailable(master({ status: 'DRAFT' }), NOW)).toBe(false);
    expect(masterAvailable(master({ current_version_id: null }), NOW)).toBe(false);
    expect(masterAvailable(master({ withdraw_effective_at: new Date('2026-11-24T00:00:00Z') }), NOW)).toBe(false);
    expect(masterAvailable(master({ withdraw_effective_at: new Date('2026-12-24T00:00:00Z') }), NOW)).toBe(true);
  });
});
