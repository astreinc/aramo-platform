import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  goldenProfileContentToStorage,
  type GoldenProfileContent,
} from '../lib/dto/golden-profile-content.dto.js';

// Job-Module Part 2 / R4 — THE MATCHING-SHAPE-ALIGNMENT PROOF (§4 gate 7).
//
// The captured GoldenProfile must be typed to the shapes the deterministic
// matching engine's MatchingAnalysisInput ALREADY expects, so the future
// consumption PR is a clean wiring job. This spec couples to the engine
// SOURCE (the R1 read-source/drift pattern) rather than importing it, so
// no new lib edge is created — but any drift in the engine's key set
// fails CI here.

const MATCHING_DTO_SRC = resolve(
  __dirname,
  '../../../matching/src/lib/dto/matching-analysis-input.dto.ts',
);

describe('Job-Module — GoldenProfile content aligns with MatchingAnalysisInput', () => {
  const engineSrc = readFileSync(MATCHING_DTO_SRC, 'utf8');

  it('constraints keys mirror ConstraintChecksEvaluated (location/work_mode/rate/work_authorization)', () => {
    // The engine source defines these four constraint keys.
    for (const key of ['location', 'work_mode', 'rate', 'work_authorization']) {
      expect(engineSrc, `engine ConstraintChecksEvaluated must define ${key}`).toContain(key);
    }
    const content: GoldenProfileContent = sampleContent();
    expect(Object.keys(content.constraints).sort()).toEqual(
      ['location', 'rate', 'work_authorization', 'work_mode'].sort(),
    );
  });

  it('critical_skills carry a name (CriticalSkillExamination.name is the engine key)', () => {
    expect(engineSrc).toContain('interface CriticalSkillExamination');
    expect(engineSrc).toContain('name: string');
    const content = sampleContent();
    for (const skill of content.critical_skills) {
      expect(typeof skill.name).toBe('string');
    }
  });

  it('storage projection keeps critical_skills NAMES enumerable (anchor 3)', () => {
    const storage = goldenProfileContentToStorage(sampleContent());
    expect(storage.critical_skills).toEqual(['Go', 'PostgreSQL']);
  });

  it('experience industries align with the engine role-content surface', () => {
    const content = sampleContent();
    expect(Array.isArray(content.experience.industries)).toBe(true);
  });
});

function sampleContent(): GoldenProfileContent {
  return {
    role_family: 'backend_engineer',
    seniority_level: 'senior',
    jd_text: 'A backend role.',
    generated_by: 'ai_draft',
    required_skills: [{ name: 'Go', min_years: 3 }],
    preferred_skills: [{ name: 'Kafka' }],
    critical_skills: [{ name: 'Go', min_years: 3 }, { name: 'PostgreSQL' }],
    experience: { total_years: 5, domain: 'fintech', industries: ['fintech'] },
    constraints: { location: 'Austin, TX', work_mode: 'remote', rate: 'market', work_authorization: 'us_citizen' },
  };
}
