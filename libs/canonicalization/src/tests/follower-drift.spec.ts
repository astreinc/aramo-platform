import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// T2-2a — MANDATORY drift-tripwire (Directive §1 Ruling 2).
//
// This test is the CONDITION OF OPTION A'S APPROVAL. Per the Directive's
// Lead ruling:
//
//   "A Cat-5 test asserts canonicalization's followed view of each
//    duplicated model (column names, types, nullability) is bit-identical
//    to the source-of-truth schema. A test runs in CI for everyone every
//    time; a hook only fires for those who installed it. Without this,
//    the duplicate definitions are a silent drift bomb — WITH it, the
//    drift goes red in CI."
//
// The tripwire compares each FOLLOWED model block in
// libs/canonicalization/prisma/schema.prisma against the SOURCE-OF-TRUTH
// block in the owning lib's schema.prisma. For each pair, the test
// extracts the body lines, strips comment/blank lines, normalizes
// whitespace, and asserts the resulting field-declaration sets are
// IDENTICAL. The same comparison is performed for each followed enum.
//
// If any followed model or enum drifts from its source (column rename,
// type change, nullability flip, attribute change), this test goes RED
// in CI — the drift bomb is defused.
//
// NOTE: T2-2a includes the ingestion additive (resolved_talent_id +
// resolution_method + ResolutionMethod enum) in BOTH the source-of-truth
// libs/ingestion/prisma/schema.prisma AND the follower
// libs/canonicalization/prisma/schema.prisma, so the drift check passes
// at T2-2a. Future PRs that modify ANY followed model in one place but
// not the other will be caught here.

const ROOT = resolve(__dirname, '../../../..');
const CANONICAL_SCHEMA = resolve(ROOT, 'libs/canonicalization/prisma/schema.prisma');
const TALENT_SCHEMA = resolve(ROOT, 'libs/talent/prisma/schema.prisma');
const TALENT_EVIDENCE_SCHEMA = resolve(ROOT, 'libs/talent-evidence/prisma/schema.prisma');
const INGESTION_SCHEMA = resolve(ROOT, 'libs/ingestion/prisma/schema.prisma');

function readSchema(path: string): string {
  return readFileSync(path, 'utf8');
}

// Extract a `model X { ... }` block body. Returns the lines BETWEEN the
// opening `{` and the closing `}`, not the opening/closing braces
// themselves. Throws if the model is not found.
function extractModelBody(schema: string, modelName: string): string {
  const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = schema.match(re);
  if (m === null || m[1] === undefined) {
    throw new Error(`model ${modelName} not found`);
  }
  return m[1];
}

// Extract an `enum X { ... }` block body. Same shape as extractModelBody.
function extractEnumBody(schema: string, enumName: string): string {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = schema.match(re);
  if (m === null || m[1] === undefined) {
    throw new Error(`enum ${enumName} not found`);
  }
  return m[1];
}

// Normalize a model body into a comparable form:
//   - drop empty lines + comment-only lines (// ...)
//   - collapse multiple whitespace into single spaces within each line
//   - trim each line
//
// The result is a SORTED array of significant declaration lines. Field
// order is therefore not load-bearing (we compare as sets); column names,
// types, nullability, and attributes ARE load-bearing.
function normalizeBody(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\s+/g, ' '))
    .sort();
}

interface FollowerSpec {
  // The model name (must match in both schemas).
  name: string;
  // The source-of-truth schema file path.
  sourcePath: string;
}

// All followed MODELS that the canonicalization follower must mirror
// bit-identical from their source-of-truth.
const FOLLOWED_MODELS: FollowerSpec[] = [
  // talent schema
  { name: 'Talent', sourcePath: TALENT_SCHEMA },
  { name: 'TalentTenantOverlay', sourcePath: TALENT_SCHEMA },
  // talent_evidence schema (7 evidence models)
  { name: 'TalentSkillEvidence', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentWorkHistoryEntry', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentContactMethod', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentRateExpectation', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentWorkAuthorization', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentDocument', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentDerivedSnapshot', sourcePath: TALENT_EVIDENCE_SCHEMA },
  // ingestion schema
  { name: 'RawPayloadReference', sourcePath: INGESTION_SCHEMA },
];

// All followed ENUMS that the canonicalization follower must mirror
// bit-identical from their source-of-truth.
const FOLLOWED_ENUMS: FollowerSpec[] = [
  // talent_evidence enums (10 — TalentSkillEvidenceSource,
  // TalentWorkHistorySource, TalentContactType,
  // TalentContactVerificationStatus, TalentEmploymentType,
  // TalentRatePeriod, TalentRateSource, TalentWorkAuthorizationStatus,
  // TalentDocumentType, TalentDocumentParseStatus,
  // TalentDocumentRetentionPolicy = 11 total)
  { name: 'TalentSkillEvidenceSource', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentWorkHistorySource', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentContactType', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentContactVerificationStatus', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentEmploymentType', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentRatePeriod', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentRateSource', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentWorkAuthorizationStatus', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentDocumentType', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentDocumentParseStatus', sourcePath: TALENT_EVIDENCE_SCHEMA },
  { name: 'TalentDocumentRetentionPolicy', sourcePath: TALENT_EVIDENCE_SCHEMA },
  // ingestion enum (T2-2a additive)
  { name: 'ResolutionMethod', sourcePath: INGESTION_SCHEMA },
];

describe('T2-2a Directive §1 Ruling 2 — MANDATORY drift-tripwire (follower bit-identical to source-of-truth)', () => {
  const followerSchema = readSchema(CANONICAL_SCHEMA);

  describe('Follower MODELS — column names, types, nullability, attributes, indexes', () => {
    for (const spec of FOLLOWED_MODELS) {
      it(`${spec.name}: canonicalization follower bit-identical to source-of-truth`, () => {
        const followerBody = normalizeBody(
          extractModelBody(followerSchema, spec.name),
        );
        const sourceBody = normalizeBody(
          extractModelBody(readSchema(spec.sourcePath), spec.name),
        );
        // The follower must contain EVERY line the source has, AND no extra.
        // We compare the sorted normalized arrays directly — bit-identical
        // means same set of declarations.
        expect(followerBody).toEqual(sourceBody);
      });
    }
  });

  describe('Follower ENUMS — value names, attributes', () => {
    for (const spec of FOLLOWED_ENUMS) {
      it(`${spec.name}: canonicalization follower bit-identical to source-of-truth`, () => {
        const followerBody = normalizeBody(
          extractEnumBody(followerSchema, spec.name),
        );
        const sourceBody = normalizeBody(
          extractEnumBody(readSchema(spec.sourcePath), spec.name),
        );
        expect(followerBody).toEqual(sourceBody);
      });
    }
  });

  // Self-test: a contrived drift demonstrates the test catches it.
  it('self-test: a fabricated drift in the comparison input is caught (the tripwire is real, not a stub)', () => {
    const followerBody = normalizeBody(
      extractModelBody(followerSchema, 'Talent'),
    );
    const driftedBody = [...followerBody];
    // Insert a phantom column declaration that does NOT appear in the
    // source-of-truth — the comparison must fail. This proves the
    // assertion is genuinely comparing, not vacuously passing.
    driftedBody.push('phantom_drift_column String');
    driftedBody.sort();
    const sourceBody = normalizeBody(
      extractModelBody(readSchema(TALENT_SCHEMA), 'Talent'),
    );
    expect(driftedBody).not.toEqual(sourceBody);
  });
});
