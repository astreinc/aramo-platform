import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '../lib/legal/legal-documents.js';

// ToS v2.0 — Lead Architect disposition (2026-11-01): a PUBLICATION-BLOCKING check. A legal text
// may be scheduled (effective_from set) only when it is finished contractual language:
//   - no review markers or placeholders: `[COUNSEL…`, `[FACT…`, `[Date of publication]`, or any
//     other square-bracket placeholder (a Markdown link `[text](url)` is not a placeholder);
//   - no empty clause: a Markdown heading followed directly by a heading of the same or a higher
//     level (or the end), or a numbered clause title (e.g. `B9.1 **Warranty.**`) with no body
//     before the next clause, heading or end;
//   - no internal engineering references: a commit-like hex id, "Claude Code", a repository path,
//     an environment-variable-like token or a PR number.
// The release-day change that sets ToS v2.0's effective_from fails CI here until counsel's
// answers are applied to the text (the open questions: Aramo/documents
// Aramo-Sign-Terms-v2_0-Counsel-Open-Questions-20261101.md). A green CI is not legal approval.

const ROOT = resolve(__dirname, '../../../..');

interface PublicationBlocker {
  line: number;
  rule: 'review-marker' | 'placeholder' | 'empty-clause' | 'internal-reference';
  text: string;
}

const CLAUSE_TITLE_ONLY = /^([A-D]\d+(?:\.\d+)*)\s+\*\*[^*]+\*\*\s*$/;
const CLAUSE_START = /^[A-D]\d+(?:\.\d+)*\s/;
const HEADING = /^(#{1,6})\s/;

const INTERNAL: readonly RegExp[] = [
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/, // commit / build / content hash (mixed hex)
  /`[0-9a-f]{7,64}`/, // a code-formatted id (e.g. a build SHA that happens to be all digits)
  /Claude Code/i,
  /(?:^|[\s(`])(?:libs|apps|doc|scripts|mobile|openapi|deploy|infrastructure[\w-]*)\/[\w./-]+/, // repo path
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/, // ENV_VAR_LIKE
  /\bPR\s?#\d+|#\d{3,}\b/, // PR / issue number
];

/** Everything in a legal text that blocks its publication (empty = publishable). */
function publicationBlockers(text: string): PublicationBlocker[] {
  const out: PublicationBlocker[] = [];
  const lines = text.split('\n');
  const nextContent = (i: number): number => {
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    return j;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/\[(?:COUNSEL|FACT)\b/i.test(line)) out.push({ line: n, rule: 'review-marker', text: line });
    else {
      // Square brackets that are not a Markdown link `[text](…)` or an escaped literal.
      const placeholders = [...line.matchAll(/(?<!\\)\[([^\]\n]*)\](?!\()/g)];
      if (placeholders.length > 0) out.push({ line: n, rule: 'placeholder', text: line });
    }
    for (const re of INTERNAL) {
      if (re.test(line)) {
        out.push({ line: n, rule: 'internal-reference', text: line });
        break;
      }
    }
    const h = HEADING.exec(line);
    if (h !== null) {
      const j = nextContent(i);
      const next = j < lines.length ? HEADING.exec(lines[j]!) : null;
      if (j >= lines.length || (next !== null && next[1]!.length <= h[1]!.length)) out.push({ line: n, rule: 'empty-clause', text: line });
    }
    if (CLAUSE_TITLE_ONLY.test(line)) {
      const j = nextContent(i);
      if (j >= lines.length || HEADING.test(lines[j]!) || CLAUSE_START.test(lines[j]!) || lines[j]!.trim() === '---') {
        out.push({ line: n, rule: 'empty-clause', text: line });
      }
    }
  });
  return out;
}

const textOf = (d: LegalDocumentVersion) => readFileSync(resolve(ROOT, d.path), 'utf8');
const scheduled = LEGAL_DOCUMENTS.filter((d) => d.effective_from !== null);
const unscheduledApproved = LEGAL_DOCUMENTS.filter((d) => d.effective_from === null && d.status === 'APPROVED');

describe('legal publication readiness — blocks scheduling an unfinished text', () => {
  it('there are scheduled texts to check', () => {
    expect(scheduled.length).toBeGreaterThan(0);
  });

  it.each(scheduled.map((d) => [`${d.key}@${d.version}`, d] as const))(
    '%s (effective_from set): no review markers, placeholders, empty clauses or internal references',
    (_id, d) => {
      expect(publicationBlockers(textOf(d))).toEqual([]);
    },
  );

  it('reports (does not fail on) the blockers of APPROVED but unscheduled texts — ToS v2.0 until counsel answers', () => {
    for (const d of unscheduledApproved) {
      const blockers = publicationBlockers(textOf(d));
      // Visible in CI logs: what must be resolved before the release-day change can schedule it.
      console.info(
        `[legal-publication-readiness] ${d.key}@${d.version} is unscheduled; ${blockers.length} blocker(s) before it may be scheduled:\n` +
          blockers.map((b) => `  line ${b.line} [${b.rule}] ${b.text.trim().slice(0, 140)}`).join('\n'),
      );
      expect(Array.isArray(blockers)).toBe(true);
    }
  });
});

describe('publicationBlockers — the rules', () => {
  it('flags review markers, placeholders and the effective-date placeholder; a Markdown link is fine', () => {
    const t = ['# T', '', 'See [the policy](https://sign.aramo.ai/legal/privacy/1.0).', '`[COUNSEL: x]`', 'Within **[30] days**.', '| Effective date | [Date of publication] |', 'A [FACT: y] here.'].join('\n');
    expect(publicationBlockers(t).map((b) => `${b.line}:${b.rule}`)).toEqual(['4:review-marker', '5:placeholder', '6:placeholder', '7:review-marker']);
  });

  it('flags empty clauses: a title-only clause before the next clause or heading, and an empty heading section', () => {
    const t = ['# Doc', '', '## B5. Renewal', '', 'B5.3 **Refunds.**', '', 'B5.4 **Price changes** take effect later.', '', '## B9. Warranties', '', 'B9.1 **Warranty.**', '', '## B10. Next', '', '## B11. Empty', '## B12. After', 'Body.'].join('\n');
    expect(publicationBlockers(t).filter((b) => b.rule === 'empty-clause').map((b) => b.line)).toEqual([5, 11, 13, 15]);
  });

  it('a part heading followed by its first sub-heading is not empty', () => {
    expect(publicationBlockers(['# PART A', '', '## A1. Scope', '', 'Text.'].join('\n'))).toEqual([]);
  });

  it('flags internal engineering references', () => {
    for (const line of ['production `06372585`, 2026-10-31', 'Prepared by Claude Code', 'see libs/subscription/src/x.ts', 'SIGN_PURGE_ENABLED=1', 'merged in PR #1057']) {
      expect(publicationBlockers(line).map((b) => b.rule)).toEqual(['internal-reference']);
    }
    expect(publicationBlockers('The fee is due within 30 days of the invoice (section B4).')).toEqual([]);
  });
});
