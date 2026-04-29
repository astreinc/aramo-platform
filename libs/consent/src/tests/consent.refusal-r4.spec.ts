import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Charter Refusal R4: no consent inference from behavior. The consent
// repository must read/write only the TalentConsentEvent ledger and its
// idempotency / audit / outbox siblings. Any code path that reads
// engagement, response, talent_event, or any behavioral table from the
// consent repo would be a refusal violation.
//
// This test is a static guardrail: it scans the repository source for
// references to forbidden tables. If a future PR wires in such a read,
// this test fails and the reviewer must check whether the change is a
// legitimate refactor or a refusal violation.

const REPO_SOURCE = readFileSync(
  new URL('../lib/consent.repository.ts', import.meta.url),
  'utf8',
);

const FORBIDDEN_REFERENCES = [
  // Engagement / behavioral tables (do not exist yet, but pre-emptive guardrail)
  'tx.engagement',
  'tx.talentResponse',
  'tx.talentEvent',
  'tx.matchScore',
  'tx.entrustability',
  'prisma.engagement',
  'prisma.talentResponse',
  'prisma.talentEvent',
];

describe('Refusal R4 — no consent inference from behavior', () => {
  it('consent.repository.ts reads/writes only consent-ledger tables', () => {
    for (const ref of FORBIDDEN_REFERENCES) {
      expect(REPO_SOURCE).not.toContain(ref);
    }
  });

  it('consent.repository.ts touches only the four PR-2 tables', () => {
    const ALLOWED = [
      'tx.idempotencyKey',
      'tx.talentConsentEvent',
      'tx.consentAuditEvent',
      'tx.outboxEvent',
    ];
    const txAccesses = REPO_SOURCE.match(/tx\.[a-zA-Z]+/g) ?? [];
    const unique = [...new Set(txAccesses)];
    for (const access of unique) {
      expect(ALLOWED).toContain(access);
    }
  });
});
