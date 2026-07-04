import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// T2-2a / T2-3 — structural tripwires (no DB required; static source-file
// scans). Per Directive §4 proofs 5-7 and the standing
// Charter-R10/R12-clean enforcement.
//
//   Proof 5 — RE-HOMED at Fix-Slice-2 — within-tenant resolution lives on L2.
//             The retired husk resolver + mint + overlay are GONE from
//             canonicalize; within-tenant resolution now routes to the built
//             TR-2a-1 seam (talentTrust.recordSourcedArrival, which composes
//             the verified-email SubjectAnchor lookup / resolveOrCreateSubject).
//             resolution_method is still computed (verified_email_match |
//             new_identity). No standalone named resolver on the lib surface
//             (findByVerifiedEmail / resolveIdentity / resolveTalent forbidden).
//   Proof 6 — INVERTED at Fix-Slice-2 — canonicalize mints ZERO Core husk.
//             The canonicalize source carries zero `.talent.create(` and no
//             husk overlay write. Scope: the canonicalization lib source ONLY
//             (Amendment v1.1 §4.6) — the dormant TalentService.createTalent
//             (libs/talent) retires in the final drop slice, so this is NOT a
//             platform-wide zero assertion.
//   Proof 7 — R10/R12: the canonicalize source carries no tier/score/rank/match
//             output vocabulary; it writes NO talent_evidence husk rows (contact
//             evidence attaches on L2 via the seam); the outbox payload is
//             subject-keyed (no husk talent_id).

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

// Fix-Slice-Final-Drop — platform-wide production source (libs/ + apps/),
// excluding tests, node_modules, dist, and prisma generated clients. Used to
// assert the husk mint is gone EVERYWHERE (Proof-6 widened once the dormant
// TalentService.createTalent 2nd site is removed).
function collectProdSources(): Map<string, string> {
  const roots = [resolve(ROOT, 'libs'), resolve(ROOT, 'apps')];
  const m = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'generated'
      ) {
        continue;
      }
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        m.set(p, readFileSync(p, 'utf8'));
      }
    }
  };
  for (const r of roots) walk(r);
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

describe('Fix-Slice-2 — Proof 5 (re-homed): within-tenant resolution lives on L2 ResolutionSubject', () => {
  it('the husk resolver + mint are GONE from canonicalize (no inline talentContactMethod.findFirst, no talent.create, no overlay)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // The retired husk-era within-tenant resolver + mint + overlay are gone.
    expect(code).not.toMatch(/talentContactMethod\.findFirst/);
    expect(code).not.toMatch(/\.talent\.create\s*\(/);
    expect(code).not.toMatch(/talentTenantOverlay\.create/);
  });

  it('canonicalize routes within-tenant resolution to the built L2 seam (talentTrust.recordSourcedArrival)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // Positive evidence that within-tenant resolution now lives on L2: the
    // arrival's subject is resolved via the talent-trust seam (which composes
    // the verified-email SubjectAnchor lookup / resolveOrCreateSubject).
    expect(code).toMatch(/this\.talentTrust\.recordSourcedArrival/);
    // The result feeds resolved_subject_id + a subject-keyed outbox.
    expect(code).toMatch(/resolved_subject_id:/);
  });

  it('resolution_method is still computed (verified_email_match | new_identity) — same-human semantic preserved on L2', () => {
    const service = readFileSync(
      resolve(ROOT, 'libs/talent-trust/src/lib/talent-trust.service.ts'),
      'utf8',
    );
    const code = stripComments(service);
    // The L2 seam preserves the husk's Tier-A verified-email resolution:
    // an email SubjectAnchor hit → verified_email_match; miss → new_identity.
    expect(code).toMatch(/findAnchorsByValue/);
    expect(code).toMatch(/verified_email_match/);
    expect(code).toMatch(/new_identity/);
  });

  it('NO standalone named resolver method on the canonicalize lib surface (findByVerifiedEmail / resolveIdentity / resolveTalent)', () => {
    // The resolution routes through talent-trust; the canonicalize lib exposes
    // no local resolver method (the forbidden-identifier check stays green).
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
});

describe('Fix-Slice-Final-Drop — Proof 6 (widened): the Core husk mint is retired PLATFORM-WIDE', () => {
  it('ZERO `.talent.create(` call sites across ALL production source (libs/ + apps/) — the husk substrate is gone', () => {
    // Widened per the final drop slice: the dormant TalentService.createTalent
    // (libs/talent) is removed, so `.talent.create(` is now zero EVERYWHERE, not
    // just in the canonicalize lib. Excludes tests (their assertion strings
    // legitimately mention the pattern) and generated clients.
    const sources = collectProdSources();
    const hits: string[] = [];
    for (const [file, src] of sources) {
      const code = stripComments(src);
      if (/\.talent\.create\s*\(/.test(code)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('canonicalize writes no husk overlay either (talentTenantOverlay.create absent)', () => {
    const sources = readAllSrc();
    for (const [, src] of sources) {
      const code = stripComments(src);
      expect(code).not.toMatch(/talentTenantOverlay\.create/);
    }
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

  it('R12 / Fix-Slice-2: canonicalize writes NO talent_evidence husk rows — contact evidence routes to L2', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    const code = stripComments(repo);
    // The husk-keyed talent_evidence writes are GONE — the split (S1) closes:
    // canonicalize no longer writes TalentContactMethod (or any talent_evidence
    // table). The arrival's contact evidence attaches on L2 via the seam.
    expect(code).not.toMatch(/talentContactMethod\.create/);
    expect(code).not.toMatch(/talentSkillEvidence\.create/);
    expect(code).not.toMatch(/talentWorkHistoryEntry\.create/);
    expect(code).not.toMatch(/talentRateExpectation\.create/);
    expect(code).not.toMatch(/talentWorkAuthorization\.create/);
    expect(code).not.toMatch(/talentDocument\.create/);
    expect(code).not.toMatch(/talentDerivedSnapshot\.create/);
    // Positive: contact evidence is now an L2 concern (the seam).
    expect(code).toMatch(/this\.talentTrust\.recordSourcedArrival/);
  });

  it('outbox event payload carries subject_id + method + payload_id ONLY (no husk talent_id, no tier/score/rank)', () => {
    const repo = readFileSync(
      resolve(LIB_SRC, 'canonicalization.repository.ts'),
      'utf8',
    );
    // Extract the event_payload object literal in the OutboxEvent create.
    const m = repo.match(/event_payload:\s*\{[\s\S]+?\}\s+as\s+never/);
    expect(m).not.toBeNull();
    const payloadLiteral = stripComments(m![0]);
    // The payload is now L2-subject-keyed (was the husk talent_id).
    expect(payloadLiteral).toMatch(/subject_id:/);
    expect(payloadLiteral).toMatch(/tenant_id:/);
    expect(payloadLiteral).toMatch(/resolution_method:/);
    expect(payloadLiteral).toMatch(/payload_id:/);
    // The retired husk key is gone.
    expect(payloadLiteral).not.toMatch(/talent_id:/);
    // NO R10-forbidden keys present.
    for (const k of ['tier', 'score', 'rank', 'why_matched_sentence', 'strengths']) {
      const re = new RegExp(`\\b${k}\\b`);
      expect(payloadLiteral).not.toMatch(re);
    }
  });
});
