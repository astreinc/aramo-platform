import { describe, expect, it } from 'vitest';

import {
  buildRequisitionSemanticDocument,
  sanitizeCommercialText,
  type RequisitionSemanticFacts,
} from '../embedding/requisition-semantic-document.js';

// GS-2B P7 — proofs for the Requisition semantic projection + the commercial-exclusion guard. The
// load-bearing test is the hostile fixture: commercial figures embedded in the free-text description
// (rates, salary, margin) must NOT reach the generated document. Commercial COLUMNS are structurally
// absent from RequisitionSemanticFacts — the type enforces column-level exclusion; this suite proves
// the residual in-text-value risk is also handled.

const BASE: RequisitionSemanticFacts = {
  title: 'Senior Platform Engineer',
  description: 'Build and operate the data platform. Kafka, Spark, AWS.',
  type: 'contract',
  job_type: 'contract_to_hire',
  role_family: 'software_engineering',
  labor_category: 'IT',
  seniority_level: 'senior',
  work_arrangement: 'hybrid',
  work_authorization: 'us_citizen',
  city: 'Reston',
  state: 'VA',
};

describe('GS-2B P7 — buildRequisitionSemanticDocument', () => {
  it('assembles the recruiting-facts document deterministically, no commercial fields present', () => {
    const a = buildRequisitionSemanticDocument(BASE);
    const b = buildRequisitionSemanticDocument(BASE);
    expect(a.document).toBe(b.document);
    expect(a.source_hash).toBe(b.source_hash);
    expect(a.document).toBe(
      [
        'Title: Senior Platform Engineer',
        'Role: contract · contract_to_hire · senior · software_engineering · IT · hybrid',
        'Location: Reston, VA',
        'Work authorization: us_citizen',
        'Description: Build and operate the data platform. Kafka, Spark, AWS.',
      ].join('\n'),
    );
  });

  it('omits blank sections with no placeholder prose', () => {
    const doc = buildRequisitionSemanticDocument({
      ...BASE,
      description: '  ',
      type: null,
      job_type: null,
      role_family: null,
      labor_category: null,
      seniority_level: null,
      work_arrangement: null,
      work_authorization: null,
      city: null,
      state: null,
    });
    expect(doc.document).toBe('Title: Senior Platform Engineer');
    expect(doc.document).not.toMatch(/unknown|n\/a|null/i);
  });

  it('HOSTILE: strips commercial figures embedded in the description', () => {
    const doc = buildRequisitionSemanticDocument({
      ...BASE,
      description:
        'Senior role. Bill rate $150/hr, pay rate 95 per hour. Salary up to $180,000. Target margin 25%. Markup 1.6x. Great team with 20% travel.',
    });
    const d = doc.document;
    expect(d).not.toContain('$150');
    expect(d).not.toContain('$180,000');
    expect(d).not.toContain('95 per hour');
    expect(d).not.toMatch(/margin\s+25/i);
    // Recruiting-relevant content survives; a non-commercial percentage (travel) is kept.
    expect(d).toContain('Senior role');
    expect(d).toContain('Great team');
    expect(d).toContain('20% travel');
  });

  it('drops a description that sanitizes to empty rather than a fallback', () => {
    const doc = buildRequisitionSemanticDocument({
      ...BASE,
      title: null,
      type: null,
      job_type: null,
      role_family: null,
      labor_category: null,
      seniority_level: null,
      work_arrangement: null,
      work_authorization: null,
      city: null,
      state: null,
      description: '$150/hr',
    });
    expect(doc.document).toBe('');
  });

  it('source_hash changes when projected content changes', () => {
    const a = buildRequisitionSemanticDocument(BASE);
    const b = buildRequisitionSemanticDocument({ ...BASE, title: 'Staff Platform Engineer' });
    expect(a.source_hash).not.toBe(b.source_hash);
  });

  it('sanitizeCommercialText removes currency, per-period rates, and comp-context numbers', () => {
    expect(sanitizeCommercialText('pay $120,000 yearly')).not.toContain('$120,000');
    expect(sanitizeCommercialText('rate 150/hr here')).not.toContain('150/hr');
    expect(sanitizeCommercialText('margin 30% target')).not.toMatch(/margin\s+30/);
    expect(sanitizeCommercialText('requires 20% travel')).toContain('20% travel');
  });
});
