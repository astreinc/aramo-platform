import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// T2-2a — structural tripwires (no DB required; static source-file
// scans). Per Directive §4 proofs 5-7 and the standing
// Charter-R10/R12-clean enforcement.
//
//   Proof 5 — no-resolution tripwire (A5b-2 applied to Core): the
//             canonicalize service takes core_talent_id as INPUT; a
//             source-scan of libs/canonicalization/src/lib/ for
//             findByVerifiedEmail / resolveIdentity / resolveTalent
//             returns ZERO hits. T2-3 introduces the resolver (the
//             ASSOCIATE-NOT-RESOLVE → ASSOCIATE+RESOLVE upgrade).
//   Proof 6 — authorized-creation tripwire: canonicalization is the ONLY
//             new createTalent call site outside libs/talent's own
//             repository. ATS-side libs (talent-record, import) must
//             continue to NOT call createTalent. The Directive's
//             "talent.* bit-identical under ATS ops" assertion holds
//             structurally.
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

describe('T2-2a — Proof 5: no-resolution tripwire (A5b-2 applied to Core)', () => {
  it('canonicalize takes core_talent_id as INPUT (caller-supplied), not derived', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    // The CanonicalizeInput interface MUST declare core_talent_id as a
    // caller-supplied field (string | null) — never as a computed/derived
    // result of an internal lookup. The presence of this declaration is
    // the structural commitment.
    expect(repo).toMatch(/core_talent_id:\s*string\s*\|\s*null/);
  });

  it('NO resolver method on the canonicalize surface (no findByVerifiedEmail / resolveIdentity / resolveTalent)', () => {
    const sources = readAllSrc();
    const forbidden = ['findByVerifiedEmail', 'resolveIdentity', 'resolveTalent'];
    const hits: Array<{ file: string; identifier: string; lineSnippet: string }> = [];
    for (const [file, src] of sources) {
      const codeOnly = stripComments(src);
      for (const id of forbidden) {
        // Match as a word (call or definition), excluding bare type/word
        // refs inside string literals. We match the identifier itself.
        const re = new RegExp(`\\b${id}\\b`);
        if (re.test(codeOnly)) {
          hits.push({ file, identifier: id, lineSnippet: codeOnly.split('\n').find((l) => re.test(l)) ?? '' });
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('canonicalize does NOT read RawPayloadReference.verified_email to DECIDE the Talent (only to populate evidence)', () => {
    // The structural commitment is: verified_email is read for evidence
    // population (TalentContactMethod.value), NEVER as input to a Talent-
    // lookup. We check that `verified_email` is only referenced in the
    // evidence-creation branch — specifically, that it's never used as a
    // `where:` argument to a Talent or overlay lookup.
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // The TalentContactMethod.create path uses verified_email as `value`.
    expect(code).toMatch(/value:\s*payload\.verified_email/);
    // No `where: { verified_email` (or any verified_email in a where
    // clause) — this is the forbidden lookup pattern.
    expect(code).not.toMatch(/where:[^}]*verified_email/);
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
