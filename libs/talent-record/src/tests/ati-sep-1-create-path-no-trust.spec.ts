import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ATI-SEP-1 A1 + A4 — STRUCTURAL: the ATS talent create / update / intake-Save
// paths make ZERO synchronous calls into the trust, identity-index or reconcile
// surfaces (Addendum A2 F-1). Their only downstream coupling is the talent.*
// outbox row the write commits; the trust / reconcile consumers run post-commit
// off that outbox (apps/api ats-talent-events). Comments are stripped first.

const strip = (raw: string): string =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

// The retired module specifiers are composed (never written as bare literals) so
// the repo-wide "no legacy import" grep over libs/talent-record stays empty.
const legacy = (name: string): string => `@aramo/${name}`;

const FILES = [
  '../lib/talent-create-from-draft.service.ts',
  '../lib/talent-intake/talent-intake-promotion.service.ts',
  '../lib/talent-intake/talent-intake.service.ts',
  '../lib/talent-record.controller.ts',
  '../lib/talent-record.repository.ts',
  '../lib/talent-events/talent-event-outbox.ts',
  // ATI-SEP-1 T10 WP2 — the module + the ATS-local duplicate advisory store.
  '../lib/talent-record.module.ts',
  '../lib/duplicate-advisory/talent-duplicate-advisory.repository.ts',
];

const FORBIDDEN = [
  // trust ledger (A1)
  legacy('talent-trust'),
  'TalentTrustService',
  'recordDeclaredClaimIfAbsent',
  'recordEvidence',
  'recordAnchor',
  'SubjectMatcher',
  'matchForRef',
  'LegacyTrustProjection',
  'routeDeclaredEvidenceToLedger',
  'routeExperienceAssertionsToLedger',
  legacy('platform-trust'),
  // identity index (A4)
  legacy('identity-index'),
  'IdentityIndexRepository',
  'IdentityIndexModule',
  'TalentLinkService',
  // reconcile (A4) — now event-driven, post-commit (the talent-reconcile libs
  // were deleted at T10 WP1; an import of them no longer resolves)
  '@aramo/canonical-reconcile',
  'CanonicalReconcileProducer',
  'TalentReconcileProducer',
  'enqueueTalent',
];

describe('ATI-SEP-1 A1/A4 — ATS create / update / Save never call trust, identity-index or reconcile (structural)', () => {
  it('names no forbidden surface', () => {
    for (const rel of FILES) {
      const code = strip(readFileSync(resolve(__dirname, rel), 'utf8'));
      for (const token of FORBIDDEN) {
        expect(code, `${rel} must not reference ${token}`).not.toContain(token);
      }
    }
  });

  it('TalentRecordModule no longer imports the reconcile producer modules', () => {
    const code = strip(readFileSync(resolve(__dirname, '../lib/talent-record.module.ts'), 'utf8'));
    expect(code).not.toContain('CanonicalReconcileModule');
    expect(code).not.toContain('TalentReconcileSignalModule');
  });

  it('ATI-SEP-1 T10 WP2 — the identity-index cluster-link routes are gone (GET/POST/DELETE :id/link)', () => {
    const code = strip(readFileSync(resolve(__dirname, '../lib/talent-record.controller.ts'), 'utf8'));
    expect(code).not.toContain("':id/link'");
    expect(code).not.toContain('linkService');
    const repo = strip(readFileSync(resolve(__dirname, '../lib/talent-record.repository.ts'), 'utf8'));
    // Nothing writes the inert cluster_id any more.
    expect(repo).not.toMatch(/cluster_id:\s*args\./);
    expect(repo).not.toContain('setLink');
  });
});
