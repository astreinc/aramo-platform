import { describe, expect, it } from 'vitest';

import {
  buildCompanySemanticDocument,
  sanitizeOrgText,
  type CompanySemanticFacts,
} from '../embedding/company-semantic-document.js';

// GS-2C — proofs for the Company semantic projection. Commercial/relationship/contact columns are
// structurally absent from CompanySemanticFacts (type-enforced); this suite proves determinism,
// section omission, and the free-text contact-strip on description.

const BASE: CompanySemanticFacts = {
  name: 'Globex Corp',
  industry: 'Software',
  description: 'A cloud data platform company.',
  key_technologies: 'Snowflake, Spark, AWS',
  city: 'Reston',
  state: 'VA',
  country: 'USA',
  ownership_type: 'private',
  employee_count_band: '201-500',
};

describe('GS-2C — buildCompanySemanticDocument', () => {
  it('assembles the org-facts document deterministically in fixed section order', () => {
    const a = buildCompanySemanticDocument(BASE);
    const b = buildCompanySemanticDocument(BASE);
    expect(a.document).toBe(b.document);
    expect(a.source_hash).toBe(b.source_hash);
    expect(a.document).toBe(
      [
        'Name: Globex Corp',
        'Industry: Software',
        'Profile: private · 201-500',
        'Technologies: Snowflake, Spark, AWS',
        'Location: Reston, VA, USA',
        'Description: A cloud data platform company.',
      ].join('\n'),
    );
  });

  it('omits blank sections with no placeholder prose', () => {
    const doc = buildCompanySemanticDocument({
      ...BASE,
      industry: null,
      description: '  ',
      key_technologies: null,
      ownership_type: null,
      employee_count_band: null,
      city: null,
      state: null,
      country: null,
    });
    expect(doc.document).toBe('Name: Globex Corp');
    expect(doc.document).not.toMatch(/unknown|n\/a|null/i);
  });

  it('strips contact material embedded in the description', () => {
    const doc = buildCompanySemanticDocument({
      ...BASE,
      description: 'Great firm. Reach sales@globex.com or +1 (703) 555-1212. See https://globex.example.com',
    });
    const d = doc.document;
    expect(d).not.toContain('sales@globex.com');
    expect(d).not.toContain('555-1212');
    expect(d).not.toContain('globex.example.com');
    expect(d).toContain('Great firm');
  });

  it('source_hash changes when projected content changes', () => {
    const a = buildCompanySemanticDocument(BASE);
    const b = buildCompanySemanticDocument({ ...BASE, industry: 'Fintech' });
    expect(a.source_hash).not.toBe(b.source_hash);
  });

  it('sanitizeOrgText removes email/phone/url, keeps other text', () => {
    expect(sanitizeOrgText('x a@b.com y')).toBe('x y');
    expect(sanitizeOrgText('call +1 703 555 1212 today')).not.toContain('555');
  });
});
