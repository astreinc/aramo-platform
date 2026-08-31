import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Lane 2 / L2-E (SB-5 / Q3) — the STRUCTURAL half of the re-expressed seam proof.
// L2-E makes ReportingService depend on Submittal DATA (the submitted event history)
// via a reporting-owned port whose implementation lives at the apps/api composition
// root. libs/reporting must NEVER acquire Submittal IMPLEMENTATION ownership: no
// import of @aramo/submittal, the submittal repositories, or a submittal prisma
// client. This guard fails the build if such an import is introduced, complementing
// lint:nx-boundaries (which, since both libs are scope:ats, would NOT block the edge —
// so this lib-internal guard is the real protection).

const SRC = resolve(__dirname, '..');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Forbidden downstream-owner implementation surfaces libs/reporting must not import.
// L2-E: Submittal (the submitted-history seam). L2-I D4b: Client-Selection (the
// interview-history seam) — the SAME A7 rule, a second owner reached only via a
// reporting-owned port whose adapter lives at the apps/api composition root.
const FORBIDDEN = [
  '@aramo/submittal',
  'SubmittalRepository',
  'TalentSubmittalEventRepository',
  'submittal/prisma/generated',
  '@aramo/client-selection',
  'InterviewSessionRepository',
  'ClientSelectionProcessRepository',
  'client-selection/prisma/generated',
];

describe('L2-E / L2-I D4b seam-exclusion — libs/reporting imports no downstream-owner implementation', () => {
  const files = collectTsFiles(SRC).filter((f) => !f.endsWith('.spec.ts'));

  it('no source file imports a submittal OR client-selection repository/client (A7 seam)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Only inspect import lines (a mention in a comment/string is not a dependency).
      for (const line of text.split('\n')) {
        if (!/^\s*import\b/.test(line) && !/\bfrom\s+['"]/.test(line)) continue;
        for (const token of FORBIDDEN) {
          if (line.includes(token)) {
            offenders.push(`${file.replace(SRC, 'libs/reporting/src')}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the reporting-owned submitted-history port exists (the seam is a port, not an import)', () => {
    const port = readFileSync(resolve(SRC, 'lib/ports/submitted-history.port.ts'), 'utf8');
    expect(port).toContain('SUBMITTED_HISTORY_PORT');
    expect(port).toContain('SubmittedHistoryPort');
    // The no-import guarantee is enforced by the first test (import-line scan); the
    // port is a pure interface + token with no runtime submittal dependency.
    expect(port).not.toMatch(/^\s*import[^\n]*@aramo\/submittal/m);
  });

  it('the reporting-owned interview-history port exists (L2-I D4b seam is a port, not an import)', () => {
    const port = readFileSync(resolve(SRC, 'lib/ports/interview-history.port.ts'), 'utf8');
    expect(port).toContain('INTERVIEW_HISTORY_PORT');
    expect(port).toContain('InterviewHistoryPort');
    expect(port).not.toMatch(/^\s*import[^\n]*@aramo\/client-selection/m);
  });
});
