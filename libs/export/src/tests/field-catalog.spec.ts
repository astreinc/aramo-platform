import { describe, expect, it } from 'vitest';

import {
  EXPORT_ENTITY_TYPES,
  getDefaultColumns,
  isExportableColumn,
  resolveColumns,
  type ExportEntityType,
} from '../lib/field-catalog.js';

// PR-A8-4 unit — the field catalog. The CRITICAL assertions:
//
//   1. R10 — every column listed is an ATS-schema name. NO Core-
//      judgment vocabulary (tier / score / rank / match / examination
//      / engagement / submittal) appears anywhere in the catalog.
//      This is the STRUCTURAL boundary at the smallest possible
//      surface (the catalog list); the integration spec replays it
//      against the wire-level CSV header rows.
//
//   2. Outbound speaks Talent — no "candidate" / "applicant" /
//      "joborder" tokens appear. The inbound vocabulary carve-out
//      (libs/import field-catalog) does NOT apply outbound — the
//      export header row uses canonical Aramo names.
//
//   3. The catalog is the SoT for the column-selection validator —
//      `resolveColumns` returns null when ANY requested column is
//      outside the catalog (which the controller turns into 400).

const ATS_ENTITIES: readonly ExportEntityType[] = [
  'company',
  'contact',
  'requisition',
  'talent_record',
  'pipeline',
];

// R10 forbidden tokens. Drawn from scripts/verify-vocabulary.sh and
// ci/scripts/verify-ats-refusal.ts — the same two-tier enforcement
// the build runs at the OpenAPI surface.
const R10_FORBIDDEN_TOKENS: readonly string[] = [
  'tier',
  'score',
  'rank',
  'match',
  'examination',
  'engagement',
  'submittal',
  'override',
  'reasoning',
];

// Outbound vocabulary anti-tokens. Inbound (libs/import) has carve-
// outs for these; outbound must NOT (the rule the §3 vocab proof
// enforces against the wire-level export header).
const OUTBOUND_VOCAB_ANTI_TOKENS: readonly string[] = [
  'candidate',
  'applicant',
  'joborder',
];

describe('field-catalog (PR-A8-4)', () => {
  describe('EXPORT_ENTITY_TYPES', () => {
    it('lists the 5 ATS entities (R10 — no Core-judgment entity)', () => {
      expect([...EXPORT_ENTITY_TYPES].sort()).toEqual([...ATS_ENTITIES].sort());
    });
  });

  describe('R10 — no Core-judgment vocabulary in any catalog', () => {
    for (const entity of ATS_ENTITIES) {
      it(`${entity} catalog contains no R10-forbidden token`, () => {
        const cols = getDefaultColumns(entity);
        for (const col of cols) {
          const lc = col.toLowerCase();
          for (const banned of R10_FORBIDDEN_TOKENS) {
            expect(
              lc.includes(banned),
              `${entity}.${col} contains R10-forbidden token "${banned}"`,
            ).toBe(false);
          }
        }
      });
    }
  });

  describe('outbound vocabulary — export speaks Talent (no inbound carve-out)', () => {
    for (const entity of ATS_ENTITIES) {
      it(`${entity} catalog contains no "candidate" / "applicant" / "joborder"`, () => {
        const cols = getDefaultColumns(entity);
        for (const col of cols) {
          const lc = col.toLowerCase();
          for (const banned of OUTBOUND_VOCAB_ANTI_TOKENS) {
            expect(
              lc.includes(banned),
              `${entity}.${col} carries outbound anti-token "${banned}"`,
            ).toBe(false);
          }
        }
      });
    }
  });

  describe('catalog content sanity', () => {
    it('every entity has at least one column', () => {
      for (const e of ATS_ENTITIES) {
        expect(getDefaultColumns(e).length).toBeGreaterThan(0);
      }
    });

    it('talent_record carries the canonical Aramo identity field names', () => {
      const cols = getDefaultColumns('talent_record');
      expect(cols).toContain('first_name');
      expect(cols).toContain('last_name');
    });

    it('talent_record does NOT export core_talent_id (dropped in 4e-rest)', () => {
      // 4e-rest retired the Core-Talent link; the cluster linkage
      // (cluster_id) is a cross-tenant id and is never exported (never
      // rendered to a tenant-visible surface).
      expect(getDefaultColumns('talent_record')).not.toContain('core_talent_id');
    });

    it('requisition exports the assignment-keyed columns the A3 predicate needs', () => {
      // recruiter_id is informational provenance only; the A3 filter
      // keys on the assignments join (composed inside listForActor).
      const cols = getDefaultColumns('requisition');
      expect(cols).toContain('title');
      expect(cols).toContain('company_id');
      expect(cols).toContain('status');
    });

    it('pipeline exports the join columns (talent_record_id, requisition_id, status)', () => {
      const cols = getDefaultColumns('pipeline');
      expect(cols).toContain('talent_record_id');
      expect(cols).toContain('requisition_id');
      expect(cols).toContain('status');
    });
  });

  describe('isExportableColumn', () => {
    it('accepts a known column', () => {
      expect(isExportableColumn('company', 'name')).toBe(true);
    });

    it('rejects an unknown column', () => {
      expect(isExportableColumn('company', 'unknown_field')).toBe(false);
    });

    it('rejects a column from a different entity', () => {
      expect(isExportableColumn('company', 'first_name')).toBe(false);
    });
  });

  describe('resolveColumns', () => {
    it('returns the default catalog when no columns requested', () => {
      const cols = resolveColumns('company', undefined);
      expect(cols).toEqual(getDefaultColumns('company'));
    });

    it('returns the default catalog when an empty array requested', () => {
      const cols = resolveColumns('company', []);
      expect(cols).toEqual(getDefaultColumns('company'));
    });

    it('returns the requested subset preserving order', () => {
      const cols = resolveColumns('company', ['zip', 'name', 'city']);
      expect(cols).toEqual(['zip', 'name', 'city']);
    });

    it('returns null when ANY requested column is unknown', () => {
      const cols = resolveColumns('company', ['name', 'not_a_field']);
      expect(cols).toBeNull();
    });
  });
});
