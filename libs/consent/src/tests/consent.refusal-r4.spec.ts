import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Charter Refusal R4: no consent inference from behavior. The consent
// repository must read/write only the consent-ledger tables. Any code
// path that reads engagement, response, talent_event, or any
// behavioral table from the consent repo would be a refusal violation.
//
// PR-3 refined the rule (ADR-0005 Decision E):
//   "No cross-event consent state derivation; single-event lookups
//    for referential linkage are allowed."
//
// PR-4 extends the rule into a TWO-CATEGORY model:
//
//   Category A — Write path (recordConsentEvent and any future write
//   methods). Decision E unchanged. Allowed: tx.idempotencyKey.findUnique,
//   tx.idempotencyKey.create, tx.talentConsentEvent.create,
//   tx.talentConsentEvent.findFirst (single-event referential linkage
//   only), tx.consentAuditEvent.create, tx.outboxEvent.create. Forbidden:
//   findMany, aggregate, groupBy, count, update, delete. Non-ledger
//   table reads forbidden everywhere.
//
//   Category B — Resolver path (resolveConsentState method body + its
//   module-private helpers). Permitted to do controlled cross-event
//   ledger reads for consent state derivation under strict bounds.
//   Allowed: tx.talentConsentEvent.findMany (cross-event read for
//   partition + latest-per-source), tx.consentAuditEvent.create
//   (decision-log write). Forbidden: update, delete, non-ledger table
//   reads.
//
// ADR-0006 (forthcoming retroactive PR-4.1) documents the two-category
// model. This static guardrail enforces the boundary mechanically.

const REPO_SOURCE = readFileSync(
  new URL('../lib/consent.repository.ts', import.meta.url),
  'utf8',
);

// Boundary markers for region splitting. The resolver method begins at
// the "async resolveConsentState(" marker; the resolver helpers begin at
// the explicit comment block introduced in PR-4.
const RESOLVER_METHOD_MARKER = 'async resolveConsentState(';
const RESOLVER_HELPERS_MARKER =
  '// Resolver-path helpers. These are module-private';

// Forbidden non-ledger table refs (anywhere in the file). Extends the
// PR-3 list with no removals; adding more pre-emptive entries as the
// program adds tables in future PRs.
const FORBIDDEN_NON_LEDGER_REFS = [
  'tx.engagement',
  'tx.talentResponse',
  'tx.talentEvent',
  'tx.matchScore',
  'tx.entrustability',
  'prisma.engagement',
  'prisma.talentResponse',
  'prisma.talentEvent',
];

// Forbidden cross-event ops in the write region (Category A). The
// resolver region (Category B) explicitly permits findMany; the write
// region does not.
const FORBIDDEN_WRITE_REGION_OPS = [
  '.findMany(',
  '.aggregate(',
  '.groupBy(',
  '.count(',
];

// Forbidden mutations in either region. The ledger is append-only;
// neither write path nor resolver path may update or delete events.
const FORBIDDEN_MUTATIONS = [
  'talentConsentEvent.update(',
  'talentConsentEvent.delete(',
  'talentConsentEvent.deleteMany(',
  'talentConsentEvent.updateMany(',
  'consentAuditEvent.update(',
  'consentAuditEvent.delete(',
];

// Identifies the byte range of the resolver path (method body + helpers).
// The resolver path is everything from `async resolveConsentState(` to
// end-of-file. This is a deliberate over-inclusion: the helpers below
// the resolver method are part of the resolver-path category by
// construction, and any code added between the resolver method and the
// helpers (e.g., new private methods on the class) inherits the
// resolver-path classification — which is the desired conservative
// behavior. New write-path code MUST be placed before the resolver
// method to receive write-path enforcement.
function splitRegions(source: string): { writeRegion: string; resolverRegion: string } {
  const resolverStart = source.indexOf(RESOLVER_METHOD_MARKER);
  if (resolverStart === -1) {
    throw new Error(
      `R4 guardrail: cannot locate resolver marker "${RESOLVER_METHOD_MARKER}" in source. ` +
        'Either the resolver method was renamed (update guardrail) or removed (refusal violation).',
    );
  }
  const helpersStart = source.indexOf(RESOLVER_HELPERS_MARKER);
  if (helpersStart === -1 || helpersStart < resolverStart) {
    throw new Error(
      `R4 guardrail: cannot locate resolver helpers marker "${RESOLVER_HELPERS_MARKER}" after the resolver method. ` +
        'Either the helpers comment was removed (update guardrail) or the helpers were moved (review classification).',
    );
  }
  return {
    writeRegion: source.slice(0, resolverStart),
    resolverRegion: source.slice(resolverStart),
  };
}

describe('Refusal R4 — two-category enforcement (PR-4: write path + resolver path)', () => {
  it('source contains the boundary markers required for region splitting', () => {
    expect(REPO_SOURCE).toContain(RESOLVER_METHOD_MARKER);
    expect(REPO_SOURCE).toContain(RESOLVER_HELPERS_MARKER);
  });

  it('no non-ledger table references anywhere in the file (R4 invariant)', () => {
    for (const ref of FORBIDDEN_NON_LEDGER_REFS) {
      expect(REPO_SOURCE).not.toContain(ref);
    }
  });

  it('no ledger mutations (update/delete) anywhere in the file (immutable ledger)', () => {
    for (const op of FORBIDDEN_MUTATIONS) {
      expect(REPO_SOURCE).not.toContain(op);
    }
  });

  describe('Category A — Write region (everything before resolveConsentState)', () => {
    const { writeRegion } = splitRegions(REPO_SOURCE);

    it('contains no findMany/aggregate/groupBy/count (Decision E original wording)', () => {
      for (const op of FORBIDDEN_WRITE_REGION_OPS) {
        expect(writeRegion).not.toContain(op);
      }
    });

    it('touches only the four PR-2/PR-3 tables (idempotencyKey, talentConsentEvent, consentAuditEvent, outboxEvent)', () => {
      const ALLOWED_TABLES = [
        'tx.idempotencyKey',
        'tx.talentConsentEvent',
        'tx.consentAuditEvent',
        'tx.outboxEvent',
      ];
      const txAccesses = writeRegion.match(/tx\.[a-zA-Z]+/g) ?? [];
      const unique = [...new Set(txAccesses)];
      for (const access of unique) {
        expect(ALLOWED_TABLES).toContain(access);
      }
    });

    it('uses only the PR-2/PR-3 allow-list operations on the ledger', () => {
      // Allowed write-region operations on the ledger (PR-2 + PR-3 combined):
      //   tx.idempotencyKey.findUnique  (PR-2 idempotency check)
      //   tx.idempotencyKey.create      (PR-2 idempotency persist)
      //   tx.talentConsentEvent.create  (PR-2 ledger write)
      //   tx.talentConsentEvent.findFirst  (PR-3 single-event linkage)
      //   tx.consentAuditEvent.create   (PR-2 audit write)
      //   tx.outboxEvent.create         (PR-2 outbox write)
      const operationCalls = writeRegion.match(/tx\.[a-zA-Z]+\.[a-zA-Z]+\(/g) ?? [];
      const ALLOWED_WRITE_OPERATIONS = new Set([
        'tx.idempotencyKey.findUnique(',
        'tx.idempotencyKey.create(',
        'tx.talentConsentEvent.create(',
        'tx.talentConsentEvent.findFirst(',
        'tx.consentAuditEvent.create(',
        'tx.outboxEvent.create(',
      ]);
      for (const call of new Set(operationCalls)) {
        expect(ALLOWED_WRITE_OPERATIONS).toContain(call);
      }
    });
  });

  describe('Category B — Resolver region (resolveConsentState body + helpers)', () => {
    const { resolverRegion } = splitRegions(REPO_SOURCE);

    it('uses only the PR-4 resolver allow-list operations on the ledger', () => {
      // Allowed resolver-region operations:
      //   tx.idempotencyKey.findUnique    (idempotency cache lookup; Phase 1
      //                                    §6 optional idempotency)
      //   tx.idempotencyKey.create        (idempotency cache persist on 200)
      //   tx.talentConsentEvent.findMany  (PR-4 cross-event read for derivation)
      //   tx.consentAuditEvent.create     (PR-4 decision-log write; Decision H)
      //   tx.consentAuditEvent.findMany   (PR-7 decision-log read; ADR-0009 §3)
      // Note: the resolver does NOT need findFirst on talentConsentEvent
      // because partition + latest-per-source is computed in memory from
      // the findMany result.
      const operationCalls = resolverRegion.match(/tx\.[a-zA-Z]+\.[a-zA-Z]+\(/g) ?? [];
      const ALLOWED_RESOLVER_OPERATIONS = new Set([
        'tx.idempotencyKey.findUnique(',
        'tx.idempotencyKey.create(',
        'tx.talentConsentEvent.findMany(',
        'tx.consentAuditEvent.create(',
        'tx.consentAuditEvent.findMany(',
      ]);
      for (const call of new Set(operationCalls)) {
        expect(ALLOWED_RESOLVER_OPERATIONS).toContain(call);
      }
    });

    it('does not touch non-ledger tables (R4 invariant; redundant with file-level check but pinned per category)', () => {
      for (const ref of FORBIDDEN_NON_LEDGER_REFS) {
        expect(resolverRegion).not.toContain(ref);
      }
    });
  });

  describe('Synthetic violation tests (verify the guardrail catches injected violations)', () => {
    it('would catch a non-ledger table read injected anywhere', () => {
      const synthetic = `${REPO_SOURCE}\n// poisoned: tx.engagement.findMany({})\n`;
      const matched = FORBIDDEN_NON_LEDGER_REFS.some((ref) => synthetic.includes(ref));
      expect(matched).toBe(true);
    });

    it('would catch a findMany injected into the write region', () => {
      const { writeRegion } = splitRegions(REPO_SOURCE);
      const poisonedWriteRegion = `${writeRegion}\n// poisoned: const all = await tx.talentConsentEvent.findMany({});\n`;
      const matched = FORBIDDEN_WRITE_REGION_OPS.some((op) =>
        poisonedWriteRegion.includes(op),
      );
      expect(matched).toBe(true);
    });

    it('would catch a ledger mutation (update/delete) injected anywhere', () => {
      const synthetic = `${REPO_SOURCE}\n// poisoned: await tx.talentConsentEvent.update({ where: { id }, data: {} });\n`;
      const matched = FORBIDDEN_MUTATIONS.some((op) => synthetic.includes(op));
      expect(matched).toBe(true);
    });

    it('would catch a non-allowlisted ledger op (e.g., findFirst) injected into the resolver region', () => {
      const { resolverRegion } = splitRegions(REPO_SOURCE);
      const poisonedResolver = `${resolverRegion}\n// poisoned: await tx.talentConsentEvent.findFirst({});\n`;
      const operationCalls = poisonedResolver.match(/tx\.[a-zA-Z]+\.[a-zA-Z]+\(/g) ?? [];
      const ALLOWED = new Set([
        'tx.idempotencyKey.findUnique(',
        'tx.idempotencyKey.create(',
        'tx.talentConsentEvent.findMany(',
        'tx.consentAuditEvent.create(',
        'tx.consentAuditEvent.findMany(',
      ]);
      const violations = [...new Set(operationCalls)].filter(
        (call) => !ALLOWED.has(call),
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(violations).toContain('tx.talentConsentEvent.findFirst(');
    });
  });
});
