import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// TM-L1-B — Arrival ≠ Talent structural boundary.
//
// The single-genuine-Talent / pre-promotion staging rule (Master Governance
// §4.1) requires that TM-L1 NEVER creates a genuine TalentRecord and NEVER
// resolves same-human identity from an arrival. Those are Lane 2 / promotion
// concerns. This spec proves the boundary STRUCTURALLY: ingestion takes no
// dependency edge on the talent-record / identity / canonicalization surfaces,
// so no code path here can create a TalentRecord or merge subjects — the
// guarantee holds by construction, not by convention.

const LIB_DIR = resolve(__dirname, '../lib');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Strip line + block comments so assertions match real code, not prose. The
// lib documents (in comments) that it does NOT merge/resolve/canonicalize;
// those words are expected in comments and must not trip the structural checks.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const LIB_FILES = collectTsFiles(LIB_DIR);
const LIB_CODE: Array<{ file: string; code: string }> = LIB_FILES.map((f) => ({
  file: f,
  code: stripComments(readFileSync(f, 'utf8')),
}));

// Cross-lifecycle surfaces TM-L1 must not take an edge on: identity resolution,
// the recruiter-facing TalentRecord, trust/evidence, canonicalization, and
// promotion all live downstream of the arrival boundary.
const FORBIDDEN_IMPORT_SPECIFIERS = [
  '@aramo/talent-record',
  '@aramo/identity',
  '@aramo/talent-trust',
  '@aramo/canonicalization',
  '@aramo/promotion',
];

// The only cross-lib edges the arrival seam legitimately needs.
const ALLOWED_ARAMO_IMPORTS = new Set([
  '@aramo/auth',
  '@aramo/common',
  '@aramo/consent',
]);

describe('TM-L1-B — Arrival ≠ Talent structural boundary', () => {
  it('has lib source files to audit', () => {
    expect(LIB_FILES.length).toBeGreaterThan(0);
  });

  it('takes no import edge on identity / TalentRecord / trust / canonicalization / promotion', () => {
    for (const { file, code } of LIB_CODE) {
      for (const forbidden of FORBIDDEN_IMPORT_SPECIFIERS) {
        expect(
          code.includes(`'${forbidden}'`) || code.includes(`"${forbidden}"`),
          `${file} must not import ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('imports only the allow-listed @aramo edges (auth / common / consent)', () => {
    const importRe = /from\s+['"](@aramo\/[^'"]+)['"]/g;
    for (const { file, code } of LIB_CODE) {
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(code)) !== null) {
        const spec = m[1]!;
        expect(
          ALLOWED_ARAMO_IMPORTS.has(spec),
          `${file} imports unexpected cross-lib edge ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('creates only RawPayloadReference — no TalentRecord / subject / cluster create path', () => {
    // The only persistence create in the arrival seam is the raw payload
    // reference. A `.create(` on any other model would be an out-of-lane write.
    const createRe = /(\w+)\s*\.\s*create\s*\(/g;
    for (const { file, code } of LIB_CODE) {
      let m: RegExpExecArray | null;
      while ((m = createRe.exec(code)) !== null) {
        const model = m[1]!;
        expect(
          model === 'rawPayloadReference',
          `${file} calls ${model}.create(...) — the arrival seam may only create rawPayloadReference`,
        ).toBe(true);
      }
    }
  });
});
