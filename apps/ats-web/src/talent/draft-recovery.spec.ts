import { describe, expect, it } from 'vitest';

import {
  addTalentDotTone,
  draftTitle,
  presentDraft,
  recoveryStripText,
  type DraftStateInput,
} from './draft-recovery';

function st(over: Partial<DraftStateInput> = {}): DraftStateInput {
  return {
    processing_status: 'READY',
    review_status: 'IN_REVIEW',
    promoted_talent_record_id: null,
    required: { met: 5, total: 5 },
    admissible: true,
    duplicate: null,
    failure: null,
    warning: null,
    ...over,
  };
}

describe('presentDraft — locked recruiter vocabulary + tones', () => {
  it('reading states map to blue "Reading résumé"', () => {
    for (const s of ['UPLOADED', 'QUEUED', 'PROCESSING']) {
      const p = presentDraft(st({ processing_status: s, admissible: false }));
      expect(p.label).toBe('Reading résumé');
      expect(p.tone).toBe('blue');
      expect(p.needsAttention).toBe(false);
    }
  });

  it('READY + admissible → green "Ready to create"', () => {
    const p = presentDraft(st({ processing_status: 'READY', admissible: true }));
    expect(p.label).toBe('Ready to create');
    expect(p.tone).toBe('green');
    expect(p.canCreate).toBe(true);
  });

  it('READY + not admissible → blue "Ready to review"', () => {
    const p = presentDraft(st({ processing_status: 'READY', admissible: false }));
    expect(p.label).toBe('Ready to review');
    expect(p.tone).toBe('blue');
    expect(p.canCreate).toBe(false);
  });

  it('FAILED → amber "Needs attention"; failure never blocks create when admissible (§13)', () => {
    const p = presentDraft(st({ processing_status: 'FAILED', admissible: true }));
    expect(p.label).toBe('Needs attention');
    expect(p.tone).toBe('amber');
    expect(p.needsAttention).toBe(true);
    expect(p.reason).toBe("Couldn't read résumé — enter details manually");
    expect(p.canCreate).toBe(true); // extraction failure does not block creation
  });

  it('PARTIAL → amber "Needs attention"', () => {
    const p = presentDraft(st({ processing_status: 'PARTIAL', admissible: false }));
    expect(p.label).toBe('Needs attention');
    expect(p.tone).toBe('amber');
  });

  it('duplicate (active email) → amber "Needs attention" with name, create blocked (no Continue anyway)', () => {
    const p = presentDraft(
      st({
        processing_status: 'READY',
        admissible: true,
        duplicate: {
          talent_record_id: 't1',
          display_name: 'Uma Maheshwari',
          title: null,
          location: null,
          reason: 'email',
          continue_anyway: false,
        },
      }),
    );
    expect(p.label).toBe('Needs attention');
    expect(p.tone).toBe('amber');
    expect(p.reason).toContain('Uma Maheshwari');
    expect(p.canCreate).toBe(false); // the 409 is preserved
  });

  it('never surfaces raw backend state words', () => {
    const banned = ['FAILED', 'PARTIAL', 'PROCESSING', 'QUEUED', 'UPLOADED'];
    for (const s of ['UPLOADED', 'QUEUED', 'PROCESSING', 'READY', 'PARTIAL', 'FAILED']) {
      const p = presentDraft(st({ processing_status: s }));
      expect(banned).not.toContain(p.label);
    }
  });
});

describe('cue + strip helpers', () => {
  it('addTalentDotTone: none → null, in-progress → blue, any attention → amber', () => {
    expect(addTalentDotTone([])).toBeNull();
    expect(addTalentDotTone([st({ processing_status: 'PROCESSING', admissible: false })])).toBe('blue');
    expect(
      addTalentDotTone([
        st({ processing_status: 'PROCESSING', admissible: false }),
        st({ processing_status: 'FAILED', admissible: false }),
      ]),
    ).toBe('amber');
  });

  it('recoveryStripText pluralizes', () => {
    expect(recoveryStripText(1)).toBe('1 talent you started adding');
    expect(recoveryStripText(3)).toBe('3 talents you started adding');
  });
});

describe('draftTitle — name precedence then filename (§5.1)', () => {
  it('prefers the extracted/review name', () => {
    expect(draftTitle({ display_name: 'Uma Maheshwari', source_filename: 'u.pdf' })).toEqual({
      title: 'Uma Maheshwari',
      file: 'u.pdf',
    });
  });
  it('falls back to filename when no name', () => {
    expect(draftTitle({ display_name: null, source_filename: 'resume_v3.pdf' })).toEqual({
      title: 'resume_v3.pdf',
      file: 'resume_v3.pdf',
    });
  });
});
