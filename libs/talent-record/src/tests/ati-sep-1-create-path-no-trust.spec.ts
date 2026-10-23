import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ATI-SEP-1 A1 — STRUCTURAL: the ATS Add-Talent create / intake-promotion path
// makes ZERO trust-ledger writes. Its only evidence collaborator is
// TalentExtractionService (now ATS typed rows only — see that lib's
// ati-sep-1-no-trust-edge.spec.ts); it never names the trust surface nor the
// TEMPORARY apps/api LegacyTrustProjectionService. Comments are stripped first.

const strip = (raw: string): string =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

const FILES = [
  '../lib/talent-create-from-draft.service.ts',
  '../lib/talent-intake/talent-intake-promotion.service.ts',
];

describe('ATI-SEP-1 A1 — ATS create path never writes the trust ledger (structural)', () => {
  it('names no trust surface and no legacy projection', () => {
    for (const rel of FILES) {
      const code = strip(readFileSync(resolve(__dirname, rel), 'utf8'));
      for (const token of [
        '@aramo/talent-trust',
        'TalentTrustService',
        'recordDeclaredClaimIfAbsent',
        'recordEvidence',
        'LegacyTrustProjection',
        'routeDeclaredEvidenceToLedger',
        'routeExperienceAssertionsToLedger',
      ]) {
        expect(code, `${rel} must not reference ${token}`).not.toContain(token);
      }
    }
  });
});
