import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Charter Refusal R4: no consent inference from behavior. The consent
// repository must read/write only the consent-ledger tables. Any code
// path that reads engagement, response, talent_event, or any
// behavioral table from the consent repo would be a refusal violation.
//
// PR-3 refines the rule (Decision E):
//   "No cross-event consent state derivation; single-event lookups
//    for referential linkage are allowed."
//
// Allowed accesses on tx (PR-3):
//   - tx.idempotencyKey.findUnique  (idempotency check; PR-2)
//   - tx.idempotencyKey.create      (idempotency persist; PR-2)
//   - tx.talentConsentEvent.create  (ledger write; PR-2)
//   - tx.talentConsentEvent.findFirst (revoked_event_id lookup; PR-3
//     Decision A — single-event lookup for referential linkage)
//   - tx.consentAuditEvent.create   (audit write; PR-2)
//   - tx.outboxEvent.create         (outbox write; PR-2)
//
// This static guardrail scans the repository source for any tx.<table>
// access outside this allow-list. If a future PR adds e.g. tx.engagement
// or a multi-event lookup like tx.talentConsentEvent.findMany, the test
// fails and the reviewer must verify whether the change is a legitimate
// refactor or a refusal violation.

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
  // Cross-event derivation: findMany would imply scanning multiple
  // ledger events — that's PR-4's resolver, not PR-3's.
  'tx.talentConsentEvent.findMany',
];

describe('Refusal R4 — no consent inference from behavior (PR-3 refinement: single-event linkage allowed)', () => {
  it('consent.repository.ts contains no forbidden table or query references', () => {
    for (const ref of FORBIDDEN_REFERENCES) {
      expect(REPO_SOURCE).not.toContain(ref);
    }
  });

  it('consent.repository.ts touches only the four PR-2/PR-3 tables', () => {
    const ALLOWED_TABLES = [
      'tx.idempotencyKey',
      'tx.talentConsentEvent',
      'tx.consentAuditEvent',
      'tx.outboxEvent',
    ];
    const txAccesses = REPO_SOURCE.match(/tx\.[a-zA-Z]+/g) ?? [];
    const unique = [...new Set(txAccesses)];
    for (const access of unique) {
      expect(ALLOWED_TABLES).toContain(access);
    }
  });

  it('consent.repository.ts uses only single-event reads (no findMany / aggregate / groupBy)', () => {
    // Decision E refinement: single-event lookups for referential linkage
    // are allowed; cross-event derivation is not.
    const FORBIDDEN_READ_OPERATIONS = [
      '.findMany(',
      '.aggregate(',
      '.groupBy(',
      '.count(',  // count implies cross-event aggregation
    ];
    for (const op of FORBIDDEN_READ_OPERATIONS) {
      expect(REPO_SOURCE).not.toContain(op);
    }
  });
});
