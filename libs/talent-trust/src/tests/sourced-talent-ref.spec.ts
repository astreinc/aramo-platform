import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SubjectRefDto } from '../lib/dto/record-evidence.dto.js';
import { RESOLUTION_SUBJECT_REF_TYPES } from '../lib/vocab.js';

// Fix-Slice-1 — SOURCED_TALENT is the L1 staging-arrival ref_type: the
// pre-promotion attachment point so evidence can accrue against a raw
// sourced_talent channel arrival BEFORE any TalentRecord exists (Lifecycle
// Spec §3.2 / §5). This unit spec pins that the closed vocabulary and its
// @IsIn DTO guard accept it (and still reject an unknown value).

const REF_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT = '11111111-1111-7111-8111-111111111111';

function refTypeErrors(refType: string) {
  const dto = plainToInstance(SubjectRefDto, {
    tenant_id: TENANT,
    ref_type: refType,
    ref_id: REF_ID,
    link_source: 'sourcing',
  });
  return validateSync(dto).filter((e) => e.property === 'ref_type');
}

describe('ResolutionSubjectRef ref_type — SOURCED_TALENT (Fix-Slice-1)', () => {
  it('is a member of the closed vocabulary', () => {
    expect(RESOLUTION_SUBJECT_REF_TYPES).toContain('SOURCED_TALENT');
    // The pre-existing members are preserved (additive, not a replacement).
    expect(RESOLUTION_SUBJECT_REF_TYPES).toEqual(
      expect.arrayContaining(['ATS_TALENT_RECORD', 'PERSON_CLUSTER', 'ANCHOR', 'SOURCED_TALENT']),
    );
  });

  it('validates a SubjectRefDto with ref_type SOURCED_TALENT', () => {
    expect(refTypeErrors('SOURCED_TALENT')).toHaveLength(0);
  });

  it('still rejects an unknown ref_type (incl. a plausible near-miss)', () => {
    expect(refTypeErrors('SOURCED_ARRIVAL')).not.toHaveLength(0);
    expect(refTypeErrors('NONSENSE')).not.toHaveLength(0);
  });
});
