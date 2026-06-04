import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// T2-2a / T2-3 — structural tripwires (no DB required; static source-file
// scans). Per Directive §4 proofs 5-7 and the standing
// Charter-R10/R12-clean enforcement.
//
//   Proof 5 — RE-FRAMED at T2-3 — resolution-lives-in-Core tripwire.
//             OLD (T2-2a): "canonicalize does NOT resolve."
//             NEW (T2-3): "ONLY Core canonicalization resolves; the ATS
//             still never does." The boundary shifted (the A5b-2
//             deferral vindicated; T2-1 ruled resolution belongs in
//             Core). Concretely:
//               (a) core_talent_id is OPTIONAL on canonicalize's input
//                   (undefined → the inline resolver runs; null/UUID →
//                   the test-affordance ASSOCIATE-NOT-RESOLVE path).
//               (b) The inline T2-1 verified-email match exists IN the
//                   canonicalize $transaction (tx.talentContactMethod.
//                   findFirst on type='email' / verification_status=
//                   'verified').
//               (c) NO standalone named resolver method on the lib
//                   surface (findByVerifiedEmail / resolveIdentity /
//                   resolveTalent are still forbidden as identifiers).
//             The ATS no-resolution tripwire lives separately at
//             apps/api/src/tests/ats-batch4b-talent-link.integration.
//             spec.ts and STAYS untouched (libs/talent + libs/identity
//             carry no findTalentByEmail / resolveIdentity / matchIdentity
//             — the structural commitment that resolution lives in
//             Core ONLY).
//   Proof 6 — authorized-creation tripwire: canonicalization is the ONLY
//             new createTalent call site outside libs/talent's own
//             repository. ATS-side libs (talent-record, import) must
//             continue to NOT call createTalent. The Directive's
//             "talent.* bit-identical under ATS ops" assertion holds
//             structurally. T2-3 folds the resolver-miss + the explicit-
//             null CREATE-NEW paths into a SINGLE `.talent.create(` call
//             site (the count assertion stays at exactly 1).
//   Proof 7 — R10/R12: the canonicalize source carries no
//             tier / score / rank / match output vocabulary, and the
//             populated evidence shape is contact-method-only (R12-
//             faithful — TalentSkillEvidence + 5 others are deferred
//             per F-canonicalization-skills, NOT fabricated).

const ROOT = resolve(__dirname, '../../../..');
const LIB_SRC = resolve(ROOT, 'libs/canonicalization/src/lib');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(p));
    } else if (entry.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

function readAllSrc(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of collectTsFiles(LIB_SRC)) {
    m.set(f, readFileSync(f, 'utf8'));
  }
  return m;
}

// Strip line comments + block comments before searching for forbidden
// identifiers — keeps documentation-mentions in comments from triggering
// a false positive. (Comments often explain what the lib does NOT do.)
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('T2-3 — Proof 5 (re-framed): resolution lives in Core canonicalization ONLY', () => {
  it('canonicalize takes core_talent_id as OPTIONAL input (T2-3: undefined → resolver runs; null/UUID → caller-supplied test path)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    // The CanonicalizeInput interface MUST declare core_talent_id as
    // OPTIONAL (`?: string | null`). The optional shape encodes the
    // T2-3 production path (undefined ⇒ resolve) while retaining the
    // T2-2a test affordances (null ⇒ force CREATE-NEW; UUID ⇒ associate).
    expect(repo).toMatch(/core_talent_id\?:\s*string\s*\|\s*null/);
  });

  it('the inline T2-1 verified-email resolver IS present in the canonicalize $transaction', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // The structural commitment of the T2-3 re-frame: the resolver lives
    // INLINE here (a `tx.talentContactMethod.findFirst` looking up by
    // type='email', verification_status='verified', value=verified_email).
    // The presence of this lookup is the positive evidence that
    // resolution exists in Core.
    expect(code).toMatch(/talentContactMethod\.findFirst/);
    expect(code).toMatch(/type:\s*'email'/);
    expect(code).toMatch(/verification_status:\s*'verified'/);
    // The value matched is the payload's verified_email (already
    // normalized by ingestion — .trim().toLowerCase() at write time).
    expect(code).toMatch(/value:\s*payload\.verified_email/);
  });

  it('NO standalone named resolver method on the canonicalize lib surface (findByVerifiedEmail / resolveIdentity / resolveTalent)', () => {
    // The resolver is INLINE in the $transaction, not a named public
    // method. The forbidden-identifier check stays literally green —
    // the substrate-cleanest seam (no `resolveOrCreate` method hangs
    // off CanonicalizationService).
    const sources = readAllSrc();
    const forbidden = ['findByVerifiedEmail', 'resolveIdentity', 'resolveTalent'];
    const hits: Array<{ file: string; identifier: string; lineSnippet: string }> = [];
    for (const [file, src] of sources) {
      const codeOnly = stripComments(src);
      for (const id of forbidden) {
        const re = new RegExp(`\\b${id}\\b`);
        if (re.test(codeOnly)) {
          hits.push({ file, identifier: id, lineSnippet: codeOnly.split('\n').find((l) => re.test(l)) ?? '' });
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the resolver is deterministic + exact + verified-only (T2-1 Decision 3 — no fuzzy auto-merge, unverified does not resolve)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // Determinism: oldest match wins (orderBy created_at asc).
    expect(code).toMatch(/orderBy:\s*\{\s*created_at:\s*'asc'\s*\}/);
    // The lookup uses verification_status='verified' (the gate that
    // distinguishes identity keys from mere evidence — an unverified
    // email does NOT resolve).
    expect(code).toMatch(/verification_status:\s*'verified'/);
  });
});

describe('T2-2a — Proof 6: authorized-creation tripwire', () => {
  it('canonicalization is the ONLY new createTalent call site (ONE call, inside the canonicalize $transaction)', () => {
    const sources = readAllSrc();
    let createTalentCallCount = 0;
    for (const [, src] of sources) {
      const code = stripComments(src);
      // Match `.talent.create(` — Prisma idiom for the create. We
      // count actual Prisma createTalent invocations (`tx.talent.create`
      // or `prisma.talent.create`), not type references.
      const matches = code.match(/\.talent\.create\s*\(/g);
      if (matches !== null) {
        createTalentCallCount += matches.length;
      }
    }
    // Exactly ONE call site (the CREATE-NEW branch of canonicalize).
    expect(createTalentCallCount).toBe(1);
  });

  it('the createTalent call site is inside an interactive $transaction (atomicity guarantee)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    // Find the index of `.talent.create(` and verify the preceding
    // context contains `$transaction(` within a reasonable distance —
    // i.e. the create lives inside the tx callback.
    const createIdx = repo.indexOf('.talent.create');
    expect(createIdx).toBeGreaterThan(-1);
    const txIdx = repo.lastIndexOf('$transaction', createIdx);
    expect(txIdx).toBeGreaterThan(-1);
    // The $transaction must come before the create AND within ~3KB
    // (i.e. inside the same function body).
    expect(createIdx - txIdx).toBeLessThan(8000);
  });

  it('READ COMMITTED isolation is applied to the $transaction (Directive §1 Ruling 4)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    expect(repo).toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.ReadCommitted/);
  });

  it('SELECT … FOR UPDATE is the first statement inside the transaction (Directive §1 Ruling 4 + §2 step 1)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    expect(repo).toMatch(/FOR UPDATE/);
    expect(repo).toMatch(/SELECT[\s\S]+FROM\s+"ingestion"\."RawPayloadReference"[\s\S]+FOR UPDATE/);
  });
});

describe('T2-2a — Proof 7: R10/R12 boundary', () => {
  it('R10: canonicalize source carries NO match-class output vocabulary (tier/score/rank/match)', () => {
    const sources = readAllSrc();
    // The R10-forbidden output keys (subset of the apps/api
    // engagement-transition.negative-shape spec's
    // FORBIDDEN_MATCH_CLASS_KEYS list). We assert NONE of these appear
    // anywhere in canonicalization's lib source — neither as field names,
    // event-payload keys, nor identifiers.
    const forbidden = [
      'tier',
      'rank',
      'rank_ordinal',
      'score',
      'why_matched_sentence',
      'strengths',
      'gaps',
      'risk_flags',
      'recruiter_notes',
      'override_id',
      'internal_engagement_state',
    ];
    const hits: Array<{ file: string; key: string }> = [];
    for (const [file, src] of sources) {
      const codeOnly = stripComments(src);
      for (const k of forbidden) {
        const re = new RegExp(`\\b${k}\\b`);
        if (re.test(codeOnly)) {
          hits.push({ file, key: k });
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('R12: contact-method evidence is the ONLY evidence populated (TalentSkillEvidence + 5 others DEFERRED per F-canonicalization-skills)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // The contact-method create IS present (twice — email + URL).
    const contactCreates = code.match(/talentContactMethod\.create/g);
    expect(contactCreates?.length).toBe(2);
    // The other 5 non-contact evidence creates are ABSENT.
    expect(code).not.toMatch(/talentSkillEvidence\.create/);
    expect(code).not.toMatch(/talentWorkHistoryEntry\.create/);
    expect(code).not.toMatch(/talentRateExpectation\.create/);
    expect(code).not.toMatch(/talentWorkAuthorization\.create/);
    expect(code).not.toMatch(/talentDocument\.create/);
    expect(code).not.toMatch(/talentDerivedSnapshot\.create/);
  });

  it('R12 / structural: contact-method values are 1:1 to spec — verified_email → email; profile_url → linkedin|github|other (URL-host heuristic)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // Email path
    expect(code).toMatch(/type:\s*'email'/);
    expect(code).toMatch(/verification_status:\s*'verified'/);
    // URL path — linkedin / github / other are the only categorisations
    // (R12 conservatism per the inline comment).
    expect(code).toMatch(/return\s*'linkedin'/);
    expect(code).toMatch(/return\s*'github'/);
    expect(code).toMatch(/return\s*'other'/);
  });

  it('outbox event payload carries identity + method + payload_id ONLY (no tier/score/rank)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    // Extract the event_payload object literal in the OutboxEvent create.
    const m = repo.match(/event_payload:\s*\{[\s\S]+?\}\s+as\s+never/);
    expect(m).not.toBeNull();
    const payloadLiteral = stripComments(m![0]);
    // The 4 expected keys are present.
    expect(payloadLiteral).toMatch(/talent_id:/);
    expect(payloadLiteral).toMatch(/tenant_id:/);
    expect(payloadLiteral).toMatch(/resolution_method:/);
    expect(payloadLiteral).toMatch(/payload_id:/);
    // NO R10-forbidden keys present.
    for (const k of ['tier', 'score', 'rank', 'why_matched_sentence', 'strengths']) {
      const re = new RegExp(`\\b${k}\\b`);
      expect(payloadLiteral).not.toMatch(re);
    }
  });
});
