import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  generateProposals,
  type OpenContradiction,
  type VerificationSlot,
} from '../lib/proposal-generator.js';

// TR-12 B1 (DDR §3 + §5a/§5e) — the pure caseworker policy engine. Fast, no DB:
// each of the three triggers proven BOTH ways (mints on the positive, silent on
// the negative), plus the structural propose-never-dispose assertion.

const NO_CONTRADICTIONS: OpenContradiction[] = [];
const NO_SLOTS: VerificationSlot[] = [];

const emailSlotVerifiedFresh: VerificationSlot = {
  anchor_id: 'a1111111-1111-7111-8111-111111111111',
  anchor_kind: 'EMAIL',
  has_current_verification: true,
  is_stale: false,
};
const emailSlotNeverVerified: VerificationSlot = {
  anchor_id: 'a2222222-2222-7222-8222-222222222222',
  anchor_kind: 'EMAIL',
  has_current_verification: false,
  is_stale: false,
};
const phoneSlotStale: VerificationSlot = {
  anchor_id: 'a3333333-3333-7333-8333-333333333333',
  anchor_kind: 'PHONE',
  has_current_verification: true,
  is_stale: true,
};
const contradiction: OpenContradiction = {
  evidence_id: 'e4444444-4444-7444-8444-444444444444',
  assertion_type: 'EMPLOYMENT',
};

describe('generateProposals — the pure caseworker (each trigger both ways)', () => {
  it('is SILENT on the all-negative subject (fresh verification, no contradiction, multi-source)', () => {
    const out = generateProposals(
      { single_source_only: false, verified_control_stale: false },
      NO_CONTRADICTIONS,
      [emailSlotVerifiedFresh],
    );
    expect(out).toEqual([]);
  });

  describe('RESOLVE_CONTRADICTION ← each open contradiction', () => {
    it('mints one per open contradiction, basis = the evidence id, snapshot = the assertion_type kind', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: false },
        [contradiction],
        NO_SLOTS,
      );
      expect(out).toEqual([
        {
          kind: 'RESOLVE_CONTRADICTION',
          trigger_kind: 'OPEN_CONTRADICTION',
          basis_ref_id: contradiction.evidence_id,
          basis_snapshot: { assertion_type: 'EMPLOYMENT' },
        },
      ]);
    });

    it('is silent when there are no open contradictions', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: false },
        NO_CONTRADICTIONS,
        NO_SLOTS,
      );
      expect(out.filter((p) => p.kind === 'RESOLVE_CONTRADICTION')).toEqual([]);
    });
  });

  describe('RENEW_VERIFICATION ← verified_control_stale', () => {
    it('mints per stale slot when the flag is set, basis = the anchor id', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: true },
        NO_CONTRADICTIONS,
        [phoneSlotStale],
      );
      expect(out).toEqual([
        {
          kind: 'RENEW_VERIFICATION',
          trigger_kind: 'VERIFIED_CONTROL_STALE',
          basis_ref_id: phoneSlotStale.anchor_id,
          basis_snapshot: { anchor_kind: 'PHONE' },
        },
      ]);
    });

    it('is silent when the flag is NOT set — even if a slot reads stale (the flag is the trigger)', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: false },
        NO_CONTRADICTIONS,
        [phoneSlotStale],
      );
      expect(out).toEqual([]);
    });

    it('is silent when the flag is set but no slot is stale', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: true },
        NO_CONTRADICTIONS,
        [emailSlotVerifiedFresh],
      );
      expect(out.filter((p) => p.kind === 'RENEW_VERIFICATION')).toEqual([]);
    });
  });

  describe('VERIFY_CONTACT ← single_source_only ∧ a never-verified slot', () => {
    it('mints per never-verified slot when single_source_only, basis = the anchor id', () => {
      const out = generateProposals(
        { single_source_only: true, verified_control_stale: false },
        NO_CONTRADICTIONS,
        [emailSlotNeverVerified],
      );
      expect(out).toEqual([
        {
          kind: 'VERIFY_CONTACT',
          trigger_kind: 'SINGLE_SOURCE_ONLY',
          basis_ref_id: emailSlotNeverVerified.anchor_id,
          basis_snapshot: { anchor_kind: 'EMAIL' },
        },
      ]);
    });

    it('is silent when NOT single_source_only — even with a never-verified slot', () => {
      const out = generateProposals(
        { single_source_only: false, verified_control_stale: false },
        NO_CONTRADICTIONS,
        [emailSlotNeverVerified],
      );
      expect(out).toEqual([]);
    });

    it('is silent when single_source_only but the slot is already verified', () => {
      const out = generateProposals(
        { single_source_only: true, verified_control_stale: false },
        NO_CONTRADICTIONS,
        [emailSlotVerifiedFresh],
      );
      expect(out.filter((p) => p.kind === 'VERIFY_CONTACT')).toEqual([]);
    });
  });

  it('never emits an ordering signal — proposals carry kinds only, no number (R10)', () => {
    const out = generateProposals(
      { single_source_only: true, verified_control_stale: true },
      [contradiction],
      [phoneSlotStale, emailSlotNeverVerified],
    );
    expect(out.length).toBeGreaterThan(0);
    // A positive allowlist: a proposal is EXACTLY these four fields — no ordering
    // ordinal of any name can sneak in, and no field carries a numeric value.
    for (const p of out) {
      expect(Object.keys(p).sort()).toEqual(
        ['basis_ref_id', 'basis_snapshot', 'kind', 'trigger_kind'].sort(),
      );
      // basis_snapshot holds only string kinds — never a number.
      for (const v of Object.values(p.basis_snapshot)) {
        expect(typeof v).not.toBe('number');
      }
    }
  });
});

// §5e — propose-never-dispose, STRUCTURAL. The pure decision engine imports ONLY
// vocab types: it can reach no action endpoint, no action service, no repo, no
// HTTP — it decides and returns rows, it executes nothing (the promotion-precedent
// posture, enforced at the source).
describe('propose-never-dispose (structural: the generator executes nothing)', () => {
  const raw = readFileSync(resolve(__dirname, '../lib/proposal-generator.ts'), 'utf8');
  // Strip comments before scanning CODE — prose documenting the boundary (which
  // names the very services the generator must not call) is not a violation (the
  // no-llm-boundary precedent: comments stripped before matching).
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('imports only from ./vocab.js (no repo, no service, no action endpoint)', () => {
    const importLines = source
      .split('\n')
      .filter((l) => /^\s*import\s/.test(l) || /\bfrom\s+['"]/.test(l));
    for (const line of importLines) {
      const m = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (m === null) continue;
      expect(m[1]).toBe('./vocab.js');
    }
  });

  it('names no action service, endpoint, or side-effecting primitive', () => {
    // The verbs a caseworker must never invoke — verification/merge/resolve
    // execution, HTTP, or the repository. It proposes; a human acts.
    const forbidden = [
      'TalentTrustRepository',
      'TalentTrustService',
      'confirmEmailVerification',
      'requestVerification',
      'resolveContradiction',
      'mergeSubjects',
      'recordEvidence',
      'prisma',
      'fetch(',
      'http',
    ];
    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
  });
});
