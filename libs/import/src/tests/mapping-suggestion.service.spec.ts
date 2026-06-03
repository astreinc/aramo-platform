import { describe, expect, it } from 'vitest';

import { MappingSuggestionService } from '../lib/mapping/mapping-suggestion.service.js';

// PR-A8-2 — unit proofs for the deterministic mapping-suggestion
// heuristic. The integration spec
// (apps/api/src/tests/ats-a8-2-suggest-mapping.integration.spec.ts)
// covers the A2 three-axis gating + the suggest→confirm→import e2e.
// These unit specs cover:
//   - synonym inference (proof §4.2)
//   - data-shape inference (proof §4.3)
//   - unmatched-required flagging (proof §4.4)
//   - determinism (proof §4.5)

describe('MappingSuggestionService — synonym inference (§4.2)', () => {
  const svc = new MappingSuggestionService();

  it('high-confidence synonym match: ["First Name","Last Name","Email Address","Phone"] → talent_record', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['First Name', 'Last Name', 'Email Address', 'Phone'],
      sample_rows: [],
    });
    const byField = new Map(res.suggestions.map((s) => [s.field, s]));
    expect(byField.get('first_name')?.suggested_source_column).toBe('First Name');
    expect(byField.get('first_name')?.confidence).toBe('high');
    expect(byField.get('first_name')?.reason).toBe('synonym');
    expect(byField.get('last_name')?.suggested_source_column).toBe('Last Name');
    expect(byField.get('last_name')?.confidence).toBe('high');
    // 'Email Address' normalizes to 'emailaddress' — exact synonym for email1.
    expect(byField.get('email1')?.suggested_source_column).toBe('Email Address');
    expect(byField.get('email1')?.confidence).toBe('high');
    // 'Phone' for talent_record is ambiguous across phone_home /
    // phone_cell / phone_work — none has 'phone' as exact synonym,
    // but substring matching makes 'phone' a SUBSTRING of phonecell /
    // phonehome / phonework. The heuristic's deterministic tie-break
    // (field-name ASC) picks phone_cell first (alphabetical: cell <
    // home < work).
    const phoneSugg = res.suggestions.filter(
      (s) => s.suggested_source_column === 'Phone',
    );
    expect(phoneSugg.length).toBe(1);
    expect(phoneSugg[0]?.confidence).toBe('medium');
    expect(phoneSugg[0]?.reason).toBe('synonym');
  });

  it('company synonyms: "Company Name" → name; "Street" → address; "Zip Code" → zip', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['Company Name', 'Street', 'Zip Code'],
      sample_rows: [],
    });
    const byField = new Map(res.suggestions.map((s) => [s.field, s]));
    expect(byField.get('name')?.suggested_source_column).toBe('Company Name');
    expect(byField.get('name')?.confidence).toBe('high');
    expect(byField.get('address')?.suggested_source_column).toBe('Street');
    expect(byField.get('zip')?.suggested_source_column).toBe('Zip Code');
  });

  it('case + punctuation insensitive: "first_name" / "FIRSTNAME" / "first-name" all match first_name', () => {
    for (const h of ['first_name', 'FIRSTNAME', 'first-name', 'First Name']) {
      const res = svc.suggest({
        target_entity: 'contact',
        headers: [h],
        sample_rows: [],
      });
      const sugg = res.suggestions.find((s) => s.field === 'first_name');
      expect(sugg?.suggested_source_column, `header=${h}`).toBe(h);
      expect(sugg?.confidence, `header=${h}`).toBe('high');
    }
  });

  it('one-to-one greedy assignment — a source column is suggested for AT MOST ONE target field', () => {
    const res = svc.suggest({
      target_entity: 'contact',
      headers: ['First Name', 'Last Name', 'Email', 'Phone'],
      sample_rows: [],
    });
    const claimed = res.suggestions
      .map((s) => s.suggested_source_column)
      .filter((v): v is string => v !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe('MappingSuggestionService — data-shape inference (§4.3)', () => {
  const svc = new MappingSuggestionService();

  it('ambiguous header ("col1","col2") with email-pattern values in col2 → suggests email1 for col2 via data-shape', () => {
    const sample_rows = [
      { col1: 'Jane', col2: 'jane@acme.com' },
      { col1: 'Bob', col2: 'bob@globex.com' },
      { col1: 'Alice', col2: 'alice@initech.com' },
      { col1: 'Carol', col2: 'carol@cyberdyne.com' },
    ];
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['col1', 'col2'],
      sample_rows,
    });
    const email1Sugg = res.suggestions.find((s) => s.field === 'email1');
    expect(email1Sugg?.suggested_source_column).toBe('col2');
    expect(email1Sugg?.reason).toBe('data-shape');
    // 100% rate → 'high'
    expect(email1Sugg?.confidence).toBe('high');
  });

  it('data-shape: date-pattern in an opaque header → suggests a date field', () => {
    const res = svc.suggest({
      target_entity: 'requisition',
      headers: ['col_x'],
      sample_rows: [
        { col_x: '2026-07-01' },
        { col_x: '2026-08-15' },
        { col_x: '2026-09-30' },
      ],
    });
    const startSugg = res.suggestions.find((s) => s.field === 'start_date');
    expect(startSugg?.suggested_source_column).toBe('col_x');
    expect(startSugg?.reason).toBe('data-shape');
  });

  it('data-shape: boolean values → suggests a boolean field (is_hot)', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['flag'],
      sample_rows: [
        { flag: 'true' },
        { flag: 'false' },
        { flag: 'yes' },
        { flag: 'no' },
      ],
    });
    const isHotSugg = res.suggestions.find((s) => s.field === 'is_hot');
    expect(isHotSugg?.suggested_source_column).toBe('flag');
    expect(isHotSugg?.reason).toBe('data-shape');
  });

  it('data-shape: empty samples → no data-shape suggestion (unmatched)', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['mystery'],
      sample_rows: [{ mystery: null }, { mystery: '' }],
    });
    const claim = res.suggestions.find(
      (s) => s.suggested_source_column === 'mystery',
    );
    // 'mystery' might substring-match some field; the LACK of data
    // is what we're asserting — no data-shape inference fires when
    // there are no non-empty samples.
    if (claim !== undefined) {
      expect(claim.reason).not.toBe('data-shape');
    }
  });
});

describe('MappingSuggestionService — unmatched-required flagging (§4.4)', () => {
  const svc = new MappingSuggestionService();

  it('contact with NO first_name header → first_name flagged unmatched-required', () => {
    const res = svc.suggest({
      target_entity: 'contact',
      headers: ['Surname', 'Email'],
      sample_rows: [],
    });
    expect(res.unmatched_required_fields).toContain('first_name');
    expect(res.unmatched_required_fields).toContain('company_id');
    const firstNameSugg = res.suggestions.find((s) => s.field === 'first_name');
    expect(firstNameSugg?.suggested_source_column).toBeNull();
    expect(firstNameSugg?.confidence).toBe('none');
    expect(firstNameSugg?.reason).toBe('unmatched');
  });

  it('company with NO name header → name flagged unmatched-required', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['Address', 'City'],
      sample_rows: [],
    });
    expect(res.unmatched_required_fields).toEqual(['name']);
    expect(
      res.suggestions.find((s) => s.field === 'name')?.suggested_source_column,
    ).toBeNull();
  });

  it('company_id is ALWAYS unmatched (FK, system-resolved) — required for contact/requisition', () => {
    for (const target of ['contact', 'requisition'] as const) {
      const res = svc.suggest({
        target_entity: target,
        headers: ['first_name', 'last_name', 'title', 'company_id'],
        sample_rows: [],
      });
      // company_id has empty synonyms → never matches even if a
      // 'company_id' header is present (the FK is system-resolved).
      const sugg = res.suggestions.find((s) => s.field === 'company_id');
      expect(sugg?.suggested_source_column, `target=${target}`).toBeNull();
      expect(res.unmatched_required_fields, `target=${target}`).toContain(
        'company_id',
      );
    }
  });

  it('talent_record happy path: required first_name + last_name BOTH matched → no unmatched-required', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['First Name', 'Last Name'],
      sample_rows: [],
    });
    expect(res.unmatched_required_fields).toEqual([]);
  });
});

describe('MappingSuggestionService — determinism (§4.5)', () => {
  const svc = new MappingSuggestionService();

  it('same input → identical output (deep equality, run twice)', () => {
    const input = {
      target_entity: 'talent_record' as const,
      headers: ['First Name', 'Last Name', 'Email', 'Cell', 'City', 'ZIP'],
      sample_rows: [
        { 'First Name': 'Jane', 'Last Name': 'Smith', Email: 'jane@x.com', Cell: '+1-617-555-0100', City: 'Boston', ZIP: '02110' },
        { 'First Name': 'Bob',  'Last Name': 'Jones', Email: 'bob@y.com',  Cell: '+1-617-555-0101', City: 'NYC',    ZIP: '10001' },
      ],
    };
    const a = svc.suggest(input);
    const b = svc.suggest(input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('determinism under header-order permutation: result is stable in catalog order, not input order', () => {
    const a = svc.suggest({
      target_entity: 'company',
      headers: ['Name', 'City', 'State'],
      sample_rows: [],
    });
    const b = svc.suggest({
      target_entity: 'company',
      headers: ['State', 'Name', 'City'],
      sample_rows: [],
    });
    // The `suggestions` list is in CATALOG ORDER (deterministic per
    // target), so both responses iterate fields in the same order —
    // and each field's suggestion is the same (the canonical name
    // synonym wins regardless of input order).
    const aBy = a.suggestions.map((s) => [s.field, s.suggested_source_column]);
    const bBy = b.suggestions.map((s) => [s.field, s.suggested_source_column]);
    expect(bBy).toEqual(aBy);
  });
});

describe('MappingSuggestionService — inbound-vocabulary aliases (Gate-5 SPLIT addition; the import-seam carve-out)', () => {
  // PR-A8-2 catalog-check addendum (Gate-5 Lead ruling): the
  // talent_record identity-field synonyms accept the outside world's
  // "Candidate" / "Applicant" headers — the import seam translates
  // them into the canonical first_name / last_name target fields.
  // This is the migration case the feature exists to serve (every
  // OpenCATS / Dice / Indeed / legacy-ATS export carries them).
  const svc = new MappingSuggestionService();

  it('"Candidate" header → first_name via synonym (high)', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['Candidate'],
      sample_rows: [],
    });
    const firstNameSugg = res.suggestions.find((s) => s.field === 'first_name');
    expect(firstNameSugg?.suggested_source_column).toBe('Candidate');
    expect(firstNameSugg?.confidence).toBe('high');
    expect(firstNameSugg?.reason).toBe('synonym');
  });

  it('"Candidate Name" header → first_name via synonym (high)', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['Candidate Name'],
      sample_rows: [],
    });
    const firstNameSugg = res.suggestions.find((s) => s.field === 'first_name');
    expect(firstNameSugg?.suggested_source_column).toBe('Candidate Name');
    expect(firstNameSugg?.confidence).toBe('high');
    expect(firstNameSugg?.reason).toBe('synonym');
  });

  it('"Applicant" header → first_name via synonym (high)', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['Applicant'],
      sample_rows: [],
    });
    const firstNameSugg = res.suggestions.find((s) => s.field === 'first_name');
    expect(firstNameSugg?.suggested_source_column).toBe('Applicant');
    expect(firstNameSugg?.confidence).toBe('high');
  });

  it('split: "Candidate First Name" / "Candidate Last Name" → first_name / last_name (high; OpenCATS migration case)', () => {
    const res = svc.suggest({
      target_entity: 'talent_record',
      headers: ['Candidate First Name', 'Candidate Last Name', 'Email'],
      sample_rows: [],
    });
    const fn = res.suggestions.find((s) => s.field === 'first_name');
    const ln = res.suggestions.find((s) => s.field === 'last_name');
    expect(fn?.suggested_source_column).toBe('Candidate First Name');
    expect(fn?.confidence).toBe('high');
    expect(ln?.suggested_source_column).toBe('Candidate Last Name');
    expect(ln?.confidence).toBe('high');
    // The required pair is matched — no unmatched-required flag.
    expect(res.unmatched_required_fields).toEqual([]);
  });

  it('boundary: "Candidate" / "Applicant" are TALENT-ONLY — NOT synonyms for any company/contact/requisition field', () => {
    // Each of the non-talent_record targets, with a single "Candidate"
    // header. The field-catalog rule §5 carve-out is talent-only; no
    // other target's catalog should claim the header.
    for (const target of ['company', 'contact', 'requisition'] as const) {
      const res = svc.suggest({
        target_entity: target,
        headers: ['Candidate'],
        sample_rows: [],
      });
      const claimed = res.suggestions.find(
        (s) => s.suggested_source_column === 'Candidate',
      );
      expect(claimed, `target=${target} should NOT claim "Candidate"`).toBeUndefined();
    }
  });
});

describe('MappingSuggestionService — reference-docs + samples (§3 contract)', () => {
  const svc = new MappingSuggestionService();

  it('response carries reference_docs per target field (type, required, example)', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['Name'],
      sample_rows: [],
    });
    const nameDoc = res.reference_docs.find((d) => d.field === 'name');
    expect(nameDoc).toBeDefined();
    expect(nameDoc?.required).toBe(true);
    expect(nameDoc?.type).toBe('string');
    expect(nameDoc?.example.length).toBeGreaterThan(0);
    expect(nameDoc?.accepted_synonyms).toContain('companyname');
  });

  it('response carries per-column samples (clipped at 5)', () => {
    const sample_rows = Array.from({ length: 10 }, (_, i) => ({
      Name: `Co ${i}`,
    }));
    const res = svc.suggest({
      target_entity: 'company',
      headers: ['Name'],
      sample_rows,
    });
    const nameSamples = res.samples.find((s) => s.source_column === 'Name');
    expect(nameSamples?.sample_values.length).toBe(5);
    expect(nameSamples?.sample_values[0]).toBe('Co 0');
  });

  it('response echoes data_shape_threshold = 0.5', () => {
    const res = svc.suggest({
      target_entity: 'company',
      headers: [],
      sample_rows: [],
    });
    expect(res.data_shape_threshold).toBe(0.5);
  });
});
