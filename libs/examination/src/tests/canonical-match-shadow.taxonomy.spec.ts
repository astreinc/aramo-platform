import { describe, expect, it } from 'vitest';

import {
  CANONICAL_MATCH_CLASSES,
  classifyCriticalSkill,
  computeShadowObservations,
  computeSourceSetDivergence,
  type NormalizedCriticalRequirement,
  type NormalizedTalentSkill,
} from '../lib/canonical-match-shadow.taxonomy.js';

// SKILL-TAX-1E — the SHADOW classifier (Gate-6 RATIFIED semantics). Classification
// is driven by the COMBINATION of two independent decisions over the FULL critical
// requisition set vs the FULL talent canonical set:
//   • name-match  = the authoritative normalized-name matcher pairs them;
//   • canonical-match = the requisition + talent skill resolve to the SAME canonical id.
// The key signal is ALIAS_EQUIVALENT: a canonical match the name matcher MISSES
// (K8s ↔ Kubernetes). canonicalization_method is NOT used. SOURCE_SET_DIVERGENCE
// preempts per-skill classification for an examination.

const K8S = '00000000-0000-7000-8000-0000000000a1';
const JAVA = '00000000-0000-7000-8000-0000000000b1';
const PYTHON = '00000000-0000-7000-8000-0000000000c1';

function req(over: Partial<NormalizedCriticalRequirement> & { norm: string }): NormalizedCriticalRequirement {
  return {
    raw_surface_form: over.raw_surface_form ?? over.norm,
    canonical_skill_id: over.canonical_skill_id ?? null,
    norm: over.norm,
  };
}
function tal(over: Partial<NormalizedTalentSkill> & { norm: string }): NormalizedTalentSkill {
  return { canonical_skill_id: over.canonical_skill_id ?? null, norm: over.norm };
}

describe('classifyCriticalSkill — ratified (name-match × canonical-match)', () => {
  it('name matches AND canonical agrees → CANONICAL_EXACT', () => {
    const obs = classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: K8S }), [
      tal({ norm: 'kubernetes', canonical_skill_id: K8S }),
    ]);
    expect(obs?.match_class).toBe('CANONICAL_EXACT');
    expect(obs?.talent_canonical_skill_id).toBe(K8S);
  });

  it('name does NOT match but canonical is the SAME → ALIAS_EQUIVALENT (the canonical-only match)', () => {
    // req "Kubernetes" (canon K8S); talent only has "K8s" (canon K8S). Normalized
    // names differ → the authoritative matcher misses it; canonical identity agrees.
    const obs = classifyCriticalSkill(req({ norm: 'kubernetes', raw_surface_form: 'Kubernetes', canonical_skill_id: K8S }), [
      tal({ norm: 'k8s', canonical_skill_id: K8S }),
    ]);
    expect(obs?.match_class).toBe('ALIAS_EQUIVALENT');
    expect(obs?.talent_canonical_skill_id).toBe(K8S);
  });

  it('name matches but canonical identities DISAGREE → CANONICAL_DIFFERENCE', () => {
    const obs = classifyCriticalSkill(req({ norm: 'java', canonical_skill_id: JAVA }), [
      tal({ norm: 'java', canonical_skill_id: PYTHON }),
    ]);
    expect(obs?.match_class).toBe('CANONICAL_DIFFERENCE');
    expect(obs?.requisition_canonical_skill_id).toBe(JAVA);
    expect(obs?.talent_canonical_skill_id).toBe(PYTHON);
  });

  it('requisition resolved, name-paired talent UNRESOLVED, no canonical match → UNRESOLVED_TALENT', () => {
    const obs = classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: K8S }), [
      tal({ norm: 'kubernetes', canonical_skill_id: null }),
    ]);
    expect(obs?.match_class).toBe('UNRESOLVED_TALENT');
    expect(obs?.talent_canonical_skill_id).toBeNull();
  });

  it('requisition UNRESOLVED, name-paired talent resolved → UNRESOLVED_REQUISITION', () => {
    const obs = classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: null }), [
      tal({ norm: 'kubernetes', canonical_skill_id: K8S }),
    ]);
    expect(obs?.match_class).toBe('UNRESOLVED_REQUISITION');
    expect(obs?.talent_canonical_skill_id).toBe(K8S);
  });

  it('name-paired but BOTH unresolved → UNRESOLVED_BOTH', () => {
    const obs = classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: null }), [
      tal({ norm: 'kubernetes', canonical_skill_id: null }),
    ]);
    expect(obs?.match_class).toBe('UNRESOLVED_BOTH');
  });

  it('no name pairing AND no canonical counterpart → NULL (talent genuinely lacks the skill)', () => {
    // req resolved, talent has an unrelated skill only.
    expect(
      classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: K8S }), [tal({ norm: 'java', canonical_skill_id: JAVA })]),
    ).toBeNull();
    // req unresolved, no pairing at all.
    expect(
      classifyCriticalSkill(req({ norm: 'kubernetes', canonical_skill_id: null }), [tal({ norm: 'java', canonical_skill_id: JAVA })]),
    ).toBeNull();
  });
});

describe('computeSourceSetDivergence — set-level integrity', () => {
  it('congruent sets → NULL', () => {
    expect(computeSourceSetDivergence(['kubernetes', 'java'], ['java', 'kubernetes'])).toBeNull();
  });
  it('incongruent sets → SOURCE_SET_DIVERGENCE (no skill anchor)', () => {
    const obs = computeSourceSetDivergence(['kubernetes'], ['kubernetes', 'java']);
    expect(obs?.match_class).toBe('SOURCE_SET_DIVERGENCE');
    expect(obs?.requisition_surface_form).toBeNull();
  });
});

describe('computeShadowObservations — SOURCE_SET_DIVERGENCE preempts per-skill', () => {
  it('congruent set → per-skill rows (incl. the canonical-only ALIAS_EQUIVALENT)', () => {
    const out = computeShadowObservations({
      criticalRequirements: [
        req({ norm: 'kubernetes', canonical_skill_id: K8S }),
        req({ norm: 'java', canonical_skill_id: JAVA }),
      ],
      talentSkills: [tal({ norm: 'k8s', canonical_skill_id: K8S }), tal({ norm: 'java', canonical_skill_id: JAVA })],
      goldenCriticalNorms: ['kubernetes', 'java'],
    });
    expect(out.map((o) => o.match_class).sort()).toEqual(['ALIAS_EQUIVALENT', 'CANONICAL_EXACT']);
  });

  it('incongruent set → ONLY SOURCE_SET_DIVERGENCE, no per-skill rows (preemption)', () => {
    const out = computeShadowObservations({
      criticalRequirements: [
        req({ norm: 'kubernetes', canonical_skill_id: K8S }),
        req({ norm: 'java', canonical_skill_id: JAVA }),
      ],
      talentSkills: [tal({ norm: 'kubernetes', canonical_skill_id: K8S })],
      goldenCriticalNorms: ['kubernetes'], // ≠ {kubernetes, java} derived → divergence
    });
    expect(out).toHaveLength(1);
    expect(out[0].match_class).toBe('SOURCE_SET_DIVERGENCE');
  });
});

describe('taxonomy closed set', () => {
  it('exposes exactly the 7 provable v1 classes', () => {
    expect(CANONICAL_MATCH_CLASSES).toHaveLength(7);
    expect(new Set(CANONICAL_MATCH_CLASSES).size).toBe(7);
  });
});
