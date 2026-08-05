import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateSync } from 'class-validator';

import { CreatePlacementDto } from '../placement/dto/placement.dto.js';

// Track 3 / E1-c — proof 10: the OpenAPI offer-snapshot surface matches the DTO
// (request) and the repository view (response). A structural conformance check
// so a wire schema and its class-validated DTO cannot drift silently.

const ATS_YAML = resolve(__dirname, '../../../../openapi/ats.yaml');

// The offer fields as the app models them, with their nullability on the
// RESPONSE surface (offered_at is always set; the rest are nullable).
const OFFER_RESPONSE_FIELDS: Record<string, { nullable: boolean }> = {
  offered_at: { nullable: false },
  proposed_start_date: { nullable: true },
  offer_expires_at: { nullable: true },
  client_offer_reference: { nullable: true },
  offer_terms_summary: { nullable: true },
};

// The offer fields on the REQUEST surface — all optional.
const OFFER_REQUEST_FIELDS = [
  'offered_at',
  'proposed_start_date',
  'offer_expires_at',
  'client_offer_reference',
  'offer_terms_summary',
];

function loadSchemas(): Record<string, any> {
  const doc = parseYaml(readFileSync(ATS_YAML, 'utf8')) as any;
  return doc.components.schemas;
}

describe('E1-c — placement offer snapshot OpenAPI ↔ DTO/view conformance (proof 10)', () => {
  it('CreatePlacementRequest declares every optional offer field', () => {
    const props = loadSchemas().CreatePlacementRequest.properties as Record<string, unknown>;
    for (const field of OFFER_REQUEST_FIELDS) {
      expect(props, `CreatePlacementRequest is missing ${field}`).toHaveProperty(field);
    }
    // Offer fields are optional: none appears in `required`.
    const required: string[] = loadSchemas().CreatePlacementRequest.required ?? [];
    for (const field of OFFER_REQUEST_FIELDS) {
      expect(required).not.toContain(field);
    }
  });

  it('PlacementProcess response declares every offer field with the correct nullability', () => {
    const schema = loadSchemas().PlacementProcess;
    const props = schema.properties as Record<string, { type: unknown }>;
    const required: string[] = schema.required ?? [];
    for (const [field, { nullable }] of Object.entries(OFFER_RESPONSE_FIELDS)) {
      expect(props, `PlacementProcess is missing ${field}`).toHaveProperty(field);
      // Every field is present in the response contract (required list).
      expect(required, `${field} must be a required response property`).toContain(field);
      const type = props[field].type;
      if (nullable) {
        // 3.1 union-null, never `nullable: true`.
        expect(Array.isArray(type) && type.includes('null'), `${field} must be union-null`).toBe(true);
      } else {
        expect(type).toBe('string');
      }
    }
  });

  it('the DTO accepts a well-formed offer snapshot and rejects an over-long reference', () => {
    const ok = Object.assign(new CreatePlacementDto(), {
      submittal_id: '00000000-0000-4000-8000-000000000001',
      requisition_id: '00000000-0000-4000-8000-000000000002',
      talent_record_id: '00000000-0000-4000-8000-000000000003',
      offered_at: '2026-08-05T12:00:00.000Z',
      proposed_start_date: '2026-09-01',
      offer_expires_at: '2026-08-12T12:00:00.000Z',
      client_offer_reference: 'CLIENT-REF-42',
      offer_terms_summary: 'Contract, 6 months, remote.',
    });
    expect(validateSync(ok)).toHaveLength(0);

    const bad = Object.assign(new CreatePlacementDto(), {
      submittal_id: '00000000-0000-4000-8000-000000000001',
      requisition_id: '00000000-0000-4000-8000-000000000002',
      talent_record_id: '00000000-0000-4000-8000-000000000003',
      client_offer_reference: 'x'.repeat(256),
    });
    const errs = validateSync(bad);
    expect(errs.some((e) => e.property === 'client_offer_reference')).toBe(true);
  });
});
