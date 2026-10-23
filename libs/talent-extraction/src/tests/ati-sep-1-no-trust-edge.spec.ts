import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ATI-SEP-1 A1 — STRUCTURAL: the ATS-owned résumé extraction lib carries NO
// trust-ledger edge. The typed-row → ledger projection moved to the TEMPORARY
// apps/api LegacyTrustProjectionService; this lib persists ATS typed rows only.
// Comments are stripped before matching (prose may name the moved surface).

const strip = (raw: string): string =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('ATI-SEP-1 A1 — talent-extraction has no trust-ledger edge (structural)', () => {
  const files = sourceFiles(resolve(__dirname, '..'));

  it('scans the lib sources', () => {
    expect(files.some((f) => f.endsWith('talent-extraction.service.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('ledger-mapper.ts'))).toBe(false); // moved out
  });

  it('imports and calls no trust surface', () => {
    for (const f of files) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const token of [
        '@aramo/talent-trust',
        'TalentTrustModule',
        'TalentTrustService',
        'recordDeclaredClaimIfAbsent',
        'routeDeclaredEvidenceToLedger',
        'backfillLedgerForTenant',
        'persistExperienceAssertions',
      ]) {
        expect(code, `${f} must not reference ${token}`).not.toContain(token);
      }
    }
  });
});
