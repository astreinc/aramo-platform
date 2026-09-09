import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  INGESTION_SOURCE_CONTRACT,
  INGESTION_SOURCES,
  deriveSourceClass,
} from '../lib/source-contract.js';

// TM-L1-A — Source / Channel Contract Reconciliation.
//
// The canonical source contract is the SINGLE structure the wire allowlist and
// the source -> source_class map derive from, and the OpenAPI IngestionSource
// enum is held equal to. These tests are the standing anti-drift guard: they
// fail the build if any of the three representations diverge, if a speculative
// future source is invented, or if a prohibited source leaks into the allowlist.

// The exact set the contract accepts today. A change here is an intentional
// contract change that must land WITH a producer + the OpenAPI enum edit — this
// literal makes an accidental widening/narrowing a failing test.
const EXPECTED_CURRENT_SOURCES = [
  'talent_direct',
  'indeed',
  'github',
  'astre_import',
] as const;

function openApiIngestionSourceEnum(): string[] {
  const yamlPath = resolve(__dirname, '../../../../openapi/ingestion.yaml');
  const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
    components?: { schemas?: { IngestionSource?: { enum?: string[] } } };
  };
  const enumValues = doc.components?.schemas?.IngestionSource?.enum;
  if (enumValues === undefined) {
    throw new Error('openapi/ingestion.yaml: components.schemas.IngestionSource.enum not found');
  }
  return enumValues;
}

function openApiProhibitedValues(): string[] {
  const yamlPath = resolve(__dirname, '../../../../openapi/ingestion.yaml');
  const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
    components?: {
      schemas?: { IngestionSource?: { ['x-prohibited-values']?: string[] } };
    };
  };
  return doc.components?.schemas?.IngestionSource?.['x-prohibited-values'] ?? [];
}

describe('TM-L1-A source contract — accepted values (no speculative widening)', () => {
  it('accepts EXACTLY the four current sources — no invented future values', () => {
    expect([...INGESTION_SOURCES]).toEqual([...EXPECTED_CURRENT_SOURCES]);
  });

  it('every contract entry is status=current today (no reserved/future value is wire-accepted)', () => {
    // The reserved axis exists, but inventing a reserved value ahead of a producer
    // is out of scope for TM-L1-A: today the accepted set == the full contract.
    const currentEntries = INGESTION_SOURCE_CONTRACT.filter(
      (e) => e.status === 'current',
    );
    expect(currentEntries.map((e) => e.source)).toEqual([
      ...EXPECTED_CURRENT_SOURCES,
    ]);
    // A `reserved` entry, if ever added, must NOT appear in the wire allowlist.
    for (const entry of INGESTION_SOURCE_CONTRACT) {
      if (entry.status === 'reserved') {
        expect(INGESTION_SOURCES).not.toContain(entry.source);
      }
    }
  });

  it('every accepted source carries an explicit human-auditable meaning', () => {
    for (const source of INGESTION_SOURCES) {
      const entry = INGESTION_SOURCE_CONTRACT.find((e) => e.source === source);
      expect(entry?.meaning.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('TM-L1-A source contract — allowlist ⊥ source_class map co-derivation', () => {
  it('deriveSourceClass is defined for every accepted source and matches the contract entry', () => {
    for (const entry of INGESTION_SOURCE_CONTRACT) {
      expect(deriveSourceClass(entry.source)).toBe(entry.source_class);
    }
  });

  it('the accepted-source set and the mapped-source set are identical (cannot drift)', () => {
    const mappedSources = INGESTION_SOURCE_CONTRACT.map((e) => e.source).sort();
    expect([...INGESTION_SOURCES].sort()).toEqual(mappedSources);
  });

  it('source_class is server-derivable to SELF or THIRD_PARTY_UNVERIFIED only (no confirming class minted yet)', () => {
    for (const source of INGESTION_SOURCES) {
      expect(['SELF', 'THIRD_PARTY_UNVERIFIED']).toContain(
        deriveSourceClass(source),
      );
    }
  });

  it('fail-closed: any unmapped / unknown / empty channel derives THIRD_PARTY_UNVERIFIED', () => {
    expect(deriveSourceClass('a_future_channel')).toBe('THIRD_PARTY_UNVERIFIED');
    // A generic non-allowlisted token (the prohibited-source-type consumer
    // precedent keeps R7-sealed vocabulary out of file content); the actual
    // R7 prohibited values are covered from x-prohibited-values below.
    expect(deriveSourceClass('myspace')).toBe('THIRD_PARTY_UNVERIFIED');
    expect(deriveSourceClass('')).toBe('THIRD_PARTY_UNVERIFIED');
  });
});

describe('TM-L1-A source contract — OpenAPI parity + R7 refusal wall', () => {
  it('openapi/ingestion.yaml IngestionSource.enum equals the wire allowlist exactly', () => {
    expect(openApiIngestionSourceEnum()).toEqual([...INGESTION_SOURCES]);
  });

  it('no prohibited (R7) source value appears in the accepted allowlist', () => {
    const prohibited = openApiProhibitedValues();
    expect(prohibited.length).toBeGreaterThan(0);
    for (const value of prohibited) {
      expect(INGESTION_SOURCES).not.toContain(value);
    }
  });
});
