import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONSENT_CHECK_OPERATIONS,
  OPERATION_SCOPE_MAP,
} from '../lib/dto/consent-check-operation.js';

// COMM-B2 — ConsentCheckOperation closed-enum parity guard. Recon (COMM-B2)
// surfaced that ConsentCheckOperation, unlike ErrorCode, had NO TS↔OpenAPI drift
// gate. This mirrors the ErrorCode parity test (libs/common error-codes.spec.ts):
// the OpenAPI schema is the source of truth and the TS tuple MUST match it
// exactly (same values, same declaration order).
describe('ConsentCheckOperation catalog parity (TS tuple ↔ openapi/common.yaml)', () => {
  it('CONSENT_CHECK_OPERATIONS matches the ConsentCheckOperation enum in openapi/common.yaml (values + order)', () => {
    const here = resolve(fileURLToPath(import.meta.url), '..');
    const yamlPath = resolve(here, '..', '..', '..', '..', 'openapi', 'common.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');

    // Line-walk (no YAML parser in the consent test surface): find the
    // ConsentCheckOperation block, its enum: header, then collect the indented
    // "- value" lines until the list ends.
    const lines = yaml.split('\n');
    const blockIdx = lines.findIndex((l) => /^\s{4}ConsentCheckOperation:\s*$/.test(l));
    expect(blockIdx).toBeGreaterThanOrEqual(0);
    const enumIdx = lines.findIndex((l, i) => i > blockIdx && /^\s{6}enum:\s*$/.test(l));
    expect(enumIdx).toBeGreaterThan(blockIdx);

    const yamlValues: string[] = [];
    for (let i = enumIdx + 1; i < lines.length; i++) {
      const m = /^\s{8}-\s+([a-z_]+)\s*$/.exec(lines[i]!);
      if (m === null) break;
      yamlValues.push(m[1]!);
    }
    expect(yamlValues).toEqual([...CONSENT_CHECK_OPERATIONS]);
  });

  it('includes the COMM-B2 `communication` operation mapped to the `contacting` scope', () => {
    expect(CONSENT_CHECK_OPERATIONS).toContain('communication');
    expect(OPERATION_SCOPE_MAP.communication).toBe('contacting');
  });
});
