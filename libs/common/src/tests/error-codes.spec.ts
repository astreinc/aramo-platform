import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../lib/errors/error-codes.js';

// PR-8.0a-Reground §10 schema/catalog test 49: ErrorCode enum in
// openapi/common.yaml MUST match ERROR_CODES tuple exactly (same values,
// same declaration order). Drift between TS tuple and YAML enum is the
// failure mode this gate prevents.
describe('ErrorCode catalog parity (TS tuple ↔ openapi/common.yaml)', () => {
  it('ERROR_CODES tuple matches ErrorCode enum in openapi/common.yaml', () => {
    const here = resolve(fileURLToPath(import.meta.url), '..');
    const yamlPath = resolve(here, '..', '..', '..', '..', 'openapi', 'common.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');

    // Walk the file line-by-line: find the ErrorCode block, locate its
    // enum: header, then collect subsequent indented "- VALUE" lines until
    // a sibling key at the same indent ends the block. Avoids pulling a
    // YAML parser into the libs/common test surface.
    const lines = yaml.split('\n');
    const errorCodeIdx = lines.findIndex((l) => /^\s{4}ErrorCode:\s*$/.test(l));
    expect(errorCodeIdx).toBeGreaterThanOrEqual(0);
    const enumIdx = lines.findIndex(
      (l, i) => i > errorCodeIdx && /^\s{6}enum:\s*$/.test(l),
    );
    expect(enumIdx).toBeGreaterThan(errorCodeIdx);

    const yamlValues: string[] = [];
    for (let i = enumIdx + 1; i < lines.length; i++) {
      const m = /^\s{8}-\s+([A-Z_]+)\s*$/.exec(lines[i]!);
      if (m === null) break;
      yamlValues.push(m[1]!);
    }
    expect(yamlValues).toEqual([...ERROR_CODES]);
  });

  it('ERROR_CODES contains the 9 codes including PR-8.0a-Reground additions', () => {
    expect(ERROR_CODES).toEqual([
      'AUTH_REQUIRED',
      'INVALID_TOKEN',
      'TENANT_ACCESS_DENIED',
      'VALIDATION_ERROR',
      'IDEMPOTENCY_KEY_CONFLICT',
      'INTERNAL_ERROR',
      'INVALID_SCOPE_COMBINATION',
      'TENANT_SELECTION_REQUIRED',
      'REFRESH_TOKEN_INVALID',
    ]);
  });
});
