import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { ALIAS_TYPES, RELATIONSHIP_SOURCES, RELATIONSHIP_TYPES } from './skills-api';
import {
  ALIAS_TYPE_LABEL,
  RELATIONSHIP_SOURCE_LABEL,
  RELATIONSHIP_TYPE_LABEL,
  aliasTypeLabel,
  directionLabel,
  proposalStatusPill,
  statusPill,
} from './skill-labels';
import { PAYLOAD_INVALID_COPY, notPendingMessage, skillErrorMessage } from './skill-errors';

// PLATFORM-UX-1 F-7 (directive R-9) — the label maps cover exactly the real enums.
describe('skill label maps (R-9: the real enums win)', () => {
  it('labels the 5 real alias types', () => {
    expect(ALIAS_TYPES.map((t) => ALIAS_TYPE_LABEL[t])).toEqual([
      'Abbreviation',
      'Common name',
      'Legacy name',
      'Vendor variant',
      'Spelling variant',
    ]);
  });

  it('labels the 6 real relationship types', () => {
    expect(RELATIONSHIP_TYPES.map((t) => RELATIONSHIP_TYPE_LABEL[t])).toEqual([
      'Related to',
      'Compatible with',
      'Parent of',
      'Built on',
      'Requires',
      'Supersedes',
    ]);
  });

  it('labels the 4 real relationship sources', () => {
    expect(RELATIONSHIP_SOURCES.map((s) => RELATIONSHIP_SOURCE_LABEL[s])).toEqual([
      'Vendor documentation',
      'Admin curated',
      'Imported taxonomy',
      'AI recommended',
    ]);
  });

  it('none of the design file’s invented values are mapped', () => {
    for (const code of ['SYNONYM', 'MISSPELLING', 'COLLOQUIAL', 'TRANSLATION']) {
      expect(aliasTypeLabel(code)).toBe(code);
    }
  });

  it('direction comes from directionality; status is Active / Inactive', () => {
    expect(directionLabel('SYMMETRIC')).toBe('↔ Symmetric');
    expect(directionLabel('DIRECTED')).toBe('→ Directed');
    expect(statusPill('active')).toEqual({ label: 'Active', tone: 'ok' });
    expect(statusPill('inactive')).toEqual({ label: 'Inactive', tone: 'muted' });
    expect(proposalStatusPill('PENDING')).toEqual({ label: 'Pending', tone: 'info' });
    expect(proposalStatusPill('ACCEPTED')).toEqual({ label: 'Accepted', tone: 'ok' });
    expect(proposalStatusPill('REJECTED')).toEqual({ label: 'Rejected', tone: 'muted' });
  });
});

describe('skill error copy', () => {
  it('SKILL_CONFLICT → plain copy by constraint, code kept', () => {
    const e = new ApiError(409, 'unique violation', 'SKILL_CONFLICT', { constraint: 'normalized_name' });
    expect(skillErrorMessage(e, 'x')).toBe('A skill with this name already exists. (SKILL_CONFLICT)');
    const a = new ApiError(409, 'unique violation', 'SKILL_CONFLICT', { constraint: 'normalized_alias' });
    expect(skillErrorMessage(a, 'x')).toBe('That alias is already in use. (SKILL_CONFLICT)');
  });

  it('SKILL_PROPOSAL_PAYLOAD_INVALID → plain copy', () => {
    const e = new ApiError(422, 'proposal payload missing required string "alias"', 'SKILL_PROPOSAL_PAYLOAD_INVALID');
    expect(skillErrorMessage(e, 'x')).toBe(`${PAYLOAD_INVALID_COPY} (SKILL_PROPOSAL_PAYLOAD_INVALID)`);
  });

  it('the 409 alert names what the other operator did', () => {
    expect(notPendingMessage('ACCEPTED')).toBe(
      'This proposal is no longer pending — it was accepted by another operator a moment ago. The list has been refreshed. (SKILL_PROPOSAL_NOT_PENDING)',
    );
    expect(notPendingMessage('REJECTED')).toContain('it was rejected by another operator');
  });

  it('a non-API error falls back', () => {
    expect(skillErrorMessage(new Error('boom'), 'Fallback.')).toBe('Fallback.');
  });
});
