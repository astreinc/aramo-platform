import { describe, expect, it } from 'vitest';

import {
  buildTalentSemanticDocument,
  coarseLocality,
  sanitizeSemanticText,
  type TalentSemanticFacts,
} from '../embedding/talent-semantic-document.js';

// GS-2 P3 — proofs for the deterministic, PII-minimized Talent semantic-source projection.
// The load-bearing test is the hostile fixture: contact/identity-style material embedded INSIDE
// an allowed free-text value (experience_summary) must NOT reach the generated document. Note that
// name/email/phone/description_text are structurally absent from the input type (TalentSemanticFacts
// / TalentWorkHistoryFact carry no such fields) — column-level exclusion is enforced by the type;
// this suite proves the residual in-text-value risk is also handled.

const BASE: TalentSemanticFacts = {
  title: 'Senior Data Engineer',
  key_skills: 'Java, AWS, Snowflake',
  current_employer: 'Acme Corp',
  city: 'Reston',
  state: 'VA',
  work_history: [],
};

describe('GS-2 P3 — buildTalentSemanticDocument', () => {
  it('assembles the compact recruiting-facts document in fixed section order and is deterministic', () => {
    const a = buildTalentSemanticDocument(BASE);
    const b = buildTalentSemanticDocument(BASE);
    expect(a.document).toBe(b.document);
    expect(a.source_hash).toBe(b.source_hash);
    expect(a.document).toBe(
      ['Title: Senior Data Engineer', 'Skills: Java, AWS, Snowflake', 'Current employer: Acme Corp', 'Location: Reston, VA'].join('\n'),
    );
  });

  it('omits blank/null sections with no placeholder prose', () => {
    const doc = buildTalentSemanticDocument({ ...BASE, key_skills: '  ', current_employer: null, city: null, state: null });
    expect(doc.document).toBe('Title: Senior Data Engineer');
    expect(doc.document).not.toMatch(/unknown|n\/a|null/i);
  });

  it('orders work history start_date DESC then id ASC, and renders role @ employer', () => {
    const doc = buildTalentSemanticDocument({
      ...BASE, title: null, key_skills: null, current_employer: null, city: null, state: null,
      work_history: [
        { role_title: 'Older', employer_name: 'E1', experience_summary: null, location: null, start_date: '2018-01-01', id: 'b' },
        { role_title: 'Newer', employer_name: 'E2', experience_summary: null, location: null, start_date: '2022-01-01', id: 'a' },
        { role_title: 'Undated', employer_name: 'E3', experience_summary: null, location: null, start_date: null, id: 'c' },
      ],
    });
    expect(doc.document).toBe(['Experience:', '- Newer @ E2', '- Older @ E1', '- Undated @ E3'].join('\n'));
  });

  it('HOSTILE: strips contact/identity material embedded inside experience_summary', () => {
    const doc = buildTalentSemanticDocument({
      ...BASE,
      work_history: [
        {
          role_title: 'Staff Engineer',
          employer_name: 'Globex',
          experience_summary:
            'Led the data platform migration. Contact jane.doe@example.com or +1 (703) 555-1212. Lives at 123 Main Street. SSN 123-45-6789. Portfolio https://jane.example.com and id 987654321.',
          location: 'Reston, VA',
          start_date: '2021-01-01',
          id: 'x',
        },
      ],
    });
    const d = doc.document;
    expect(d).not.toContain('jane.doe@example.com');
    expect(d).not.toContain('555-1212');
    expect(d).not.toContain('123-45-6789');
    expect(d).not.toContain('123 Main Street');
    expect(d).not.toContain('jane.example.com');
    expect(d).not.toContain('987654321');
    // recruiting-relevant content survives + coarse location kept:
    expect(d).toContain('Led the data platform migration');
    expect(d).toContain('Staff Engineer @ Globex');
    expect(d).toContain('(Reston, VA)');
  });

  it('coarse-normalizes work-history location or omits an un-normalizable one', () => {
    expect(coarseLocality('Reston, VA')).toBe('Reston, VA');
    expect(coarseLocality('  Reston ,  Virginia ')).toBe('Reston, Virginia');
    expect(coarseLocality('remote-ish, somewhere over the rainbow 12345')).toBeNull();
    expect(coarseLocality(null)).toBeNull();
    const doc = buildTalentSemanticDocument({
      ...BASE, title: null, key_skills: null, current_employer: null, city: null, state: null,
      work_history: [{ role_title: 'R', employer_name: 'E', experience_summary: null, location: 'not a locality!!', start_date: null, id: 'a' }],
    });
    expect(doc.document).toBe(['Experience:', '- R @ E'].join('\n')); // location omitted
  });

  it('drops an experience_summary that sanitizes to empty (no summary rather than a fallback)', () => {
    const doc = buildTalentSemanticDocument({
      ...BASE, title: null, key_skills: null, current_employer: null, city: null, state: null,
      work_history: [{ role_title: 'R', employer_name: 'E', experience_summary: 'jane@x.com 703-555-1212', location: null, start_date: null, id: 'a' }],
    });
    expect(doc.document).toBe(['Experience:', '- R @ E'].join('\n'));
  });

  it('source_hash changes when projected content changes', () => {
    const a = buildTalentSemanticDocument(BASE);
    const b = buildTalentSemanticDocument({ ...BASE, title: 'Principal Engineer' });
    expect(a.source_hash).not.toBe(b.source_hash);
  });

  it('sanitizeSemanticText collapses whitespace and removes contact patterns', () => {
    expect(sanitizeSemanticText('a\n\n  b')).toBe('a b');
    expect(sanitizeSemanticText('x jane@x.com y')).toBe('x y');
  });
});
