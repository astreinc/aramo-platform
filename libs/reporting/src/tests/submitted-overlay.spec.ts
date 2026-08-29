import { describe, expect, it } from 'vitest';

import {
  applySubmittedOverlayToBuckets,
  isEffectivelySubmitted,
  submittedBandOverlayByRequisition,
} from '../lib/ports/submitted-overlay.js';

// Lane 2 / L2-E (SB-5) — the pure overlay semantic that makes the Pipeline-mirror
// removal value-preserving. The two load-bearing cases are PARITY (mirror present:
// current='submitted' → overlay no-op) and POST-REMOVAL (current='qualifying' →
// overlay moves the grain into submitted). Both must yield the same submitted count.

describe('isEffectivelySubmitted', () => {
  it('pre-submitted active stages are effectively submitted', () => {
    for (const s of ['no_contact', 'contacted', 'talent_responded', 'qualifying', 'qualified']) {
      expect(isEffectivelySubmitted(s)).toBe(true);
    }
  });
  it('submitted itself / advanced / terminal / absent are NOT (raw wins)', () => {
    expect(isEffectivelySubmitted('submitted')).toBe(false); // already counted
    expect(isEffectivelySubmitted('interviewing')).toBe(false);
    expect(isEffectivelySubmitted('offered')).toBe(false);
    expect(isEffectivelySubmitted('placed')).toBe(false);
    expect(isEffectivelySubmitted('not_in_consideration')).toBe(false);
    expect(isEffectivelySubmitted('completed')).toBe(false);
    expect(isEffectivelySubmitted(undefined)).toBe(false);
  });
});

describe('applySubmittedOverlayToBuckets — PARITY (mirror present) is a no-op', () => {
  it('a grain whose current episode IS submitted leaves buckets unchanged', () => {
    // Mirror-present world: countByStatus already put the grain in `submitted`.
    const raw = [
      { status: 'qualifying', count: 2 },
      { status: 'submitted', count: 1 },
    ];
    const grains = [{ talent_id: 't1', requisition_id: 'r1' }];
    const current = new Map([['t1:r1', 'submitted']]); // mirror wrote it
    const out = applySubmittedOverlayToBuckets(raw, grains, current);
    expect(new Map(out.map((b) => [b.status, b.count]))).toEqual(
      new Map([
        ['qualifying', 2],
        ['submitted', 1],
      ]),
    );
  });
});

describe('applySubmittedOverlayToBuckets — POST-REMOVAL moves the grain, no double count', () => {
  it('a submitted grain resting at qualifying is moved into submitted', () => {
    // Post-removal: the grain rests at qualifying (mirror gone); event history says
    // it is submitted. Overlay moves 1 qualifying → submitted. Same submitted count
    // (1) as the parity world above.
    const raw = [{ status: 'qualifying', count: 3 }];
    const grains = [{ talent_id: 't1', requisition_id: 'r1' }];
    const current = new Map([['t1:r1', 'qualifying']]);
    const out = applySubmittedOverlayToBuckets(raw, grains, current);
    expect(new Map(out.map((b) => [b.status, b.count]))).toEqual(
      new Map([
        ['qualifying', 2], // 3 - 1
        ['submitted', 1], // 0 + 1
      ]),
    );
  });

  it('a submitted-then-advanced grain (current=interviewing) stays in interviewing only', () => {
    const raw = [{ status: 'interviewing', count: 1 }];
    const grains = [{ talent_id: 't2', requisition_id: 'r1' }];
    const current = new Map([['t2:r1', 'interviewing']]); // advanced past submitted
    const out = applySubmittedOverlayToBuckets(raw, grains, current);
    expect(new Map(out.map((b) => [b.status, b.count]))).toEqual(
      new Map([['interviewing', 1]]), // raw wins, no submitted bucket
    );
  });

  it('drops a bucket that overlay empties to zero', () => {
    const raw = [{ status: 'qualifying', count: 1 }];
    const grains = [{ talent_id: 't1', requisition_id: 'r1' }];
    const current = new Map([['t1:r1', 'qualifying']]);
    const out = applySubmittedOverlayToBuckets(raw, grains, current);
    expect(new Map(out.map((b) => [b.status, b.count]))).toEqual(
      new Map([['submitted', 1]]), // qualifying 1→0 dropped
    );
  });
});

describe('submittedBandOverlayByRequisition — R2 band add (no double-add)', () => {
  it('adds pre-submitted grains per requisition; skips advanced/absent', () => {
    const grains = [
      { talent_id: 't1', requisition_id: 'r1' }, // qualifying → add
      { talent_id: 't2', requisition_id: 'r1' }, // interviewing → skip (raw band already counts)
      { talent_id: 't3', requisition_id: 'r2' }, // qualified → add
      { talent_id: 't4', requisition_id: 'r2' }, // submitted (parity) → skip
    ];
    const current = new Map([
      ['t1:r1', 'qualifying'],
      ['t2:r1', 'interviewing'],
      ['t3:r2', 'qualified'],
      ['t4:r2', 'submitted'],
    ]);
    const byReq = submittedBandOverlayByRequisition(grains, current);
    expect(byReq.get('r1')).toBe(1);
    expect(byReq.get('r2')).toBe(1);
  });
});
