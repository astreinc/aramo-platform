import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- pdf-parse ships CJS without TS types (see text-extractor.ts).
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

import {
  assessPdfCompleteness,
  extractPdfText,
  extractResumeText,
  type PdfPageRecord,
  type PdfTextItem,
  PDF_SAME_BASELINE_SEPARATOR_EM,
  renderPdfPageItems,
  RESUME_TEXT_EXTRACTOR_VERSION,
} from '../lib/heuristics/text-extractor.js';
import { RESUME_SOURCE_MAP_VERSION, buildResumeSourceMap } from '../lib/source-map.js';

// RESUME-A1 v1.1 (LOCKED) — PDF reading remediation.
//   R1: restore the separator between same-baseline text items (0.25 em, D-1).
//   R2: a page that was not rendered, failed, or yielded no text fails the
//       whole extraction (null — the existing caller contract, D-2/D-3).
// Fixtures are SYNTHETIC CoreGraphics PDFs (fixtures/pdf/generate-fixtures.swift);
// pdf-lib output is not a valid oracle under pdf.js v1.10 (§10 item 7).

const FIXTURES = resolve(__dirname, 'fixtures/pdf');
const fixture = (name: string): Buffer => readFileSync(resolve(FIXTURES, `${name}.pdf`));
const nonWhitespace = (s: string): string => s.replace(/\s/g, '');

// pdf-parse's own default renderer — the pre-A1 behaviour, used as the oracle
// for the "only whitespace changes" invariants (R1.4).
async function defaultPdfParseText(buf: Buffer): Promise<string> {
  return ((await pdfParse(buf)) as { text: string }).text;
}

const item = (str: string, x: number, y: number, width: number, size = 10): PdfTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
});

describe('RESUME-A1 R1 — renderPdfPageItems (same-baseline separator)', () => {
  it('inserts one space when the same-baseline gap is >= 0.25 em', () => {
    // 10pt font: 2.5pt gap = exactly the threshold.
    expect(renderPdfPageItems([item('TOOLS', 0, 700, 30), item('Jira', 32.5, 700, 20)])).toBe(
      'TOOLS Jira',
    );
  });

  it('inserts nothing below the threshold (hyphen joins, letter spacing)', () => {
    expect(renderPdfPageItems([item('follow', 0, 700, 30), item('-', 30.5, 700, 3)])).toBe(
      'follow-',
    );
    expect(renderPdfPageItems([item('S', 0, 700, 6), item('U', 8, 700, 6)])).toBe('SU');
  });

  it('never doubles existing whitespace on either side', () => {
    expect(renderPdfPageItems([item('Senior ', 0, 700, 35), item('Engineer', 60, 700, 40)])).toBe(
      'Senior Engineer',
    );
    expect(renderPdfPageItems([item('Senior', 0, 700, 30), item(' Engineer', 60, 700, 45)])).toBe(
      'Senior Engineer',
    );
  });

  it('keeps the default line logic: a different baseline is a newline, never a space', () => {
    expect(renderPdfPageItems([item('Line one', 0, 700, 40), item('Line two', 0, 680, 40)])).toBe(
      'Line one\nLine two',
    );
  });

  it("preserves pdf-parse's !lastY quirk (a y=0 item never starts a newline)", () => {
    expect(renderPdfPageItems([item('Footer', 0, 0, 30), item('Next', 0, 700, 20)])).toBe(
      'FooterNext',
    );
  });

  it('inserts nothing when the font size is unusable', () => {
    expect(renderPdfPageItems([item('A', 0, 700, 5, 0), item('B', 100, 700, 5, 0)])).toBe('AB');
  });

  it('threshold is the governed 0.25 em constant', () => {
    expect(PDF_SAME_BASELINE_SEPARATOR_EM).toBe(0.25);
  });
});

describe('RESUME-A1 R2 — assessPdfCompleteness (page accounting vs declared page count)', () => {
  const ok: PdfPageRecord = { resolved: true, nonWhitespaceChars: 12 };

  it('complete when every declared page resolved with text', () => {
    expect(assessPdfCompleteness(2, new Map([[1, ok], [2, ok]]))).toBeNull();
  });

  it('page never reached (e.g. getPage rejected before pagerender) → page_not_rendered', () => {
    expect(assessPdfCompleteness(3, new Map([[1, ok], [3, ok]]))).toEqual({
      reason: 'page_not_rendered',
      page_index: 2,
    });
  });

  it('page render rejected → page_render_failed', () => {
    const failed: PdfPageRecord = { resolved: false, nonWhitespaceChars: 0 };
    expect(assessPdfCompleteness(2, new Map([[1, ok], [2, failed]]))).toEqual({
      reason: 'page_render_failed',
      page_index: 2,
    });
  });

  it('page resolved with no text → page_no_text (incomplete, not "corrupt")', () => {
    const empty: PdfPageRecord = { resolved: true, nonWhitespaceChars: 0 };
    expect(assessPdfCompleteness(2, new Map([[1, ok], [2, empty]]))).toEqual({
      reason: 'page_no_text',
      page_index: 2,
    });
  });

  it('zero declared pages: nothing to account (the empty-text check returns null)', () => {
    expect(assessPdfCompleteness(0, new Map())).toBeNull();
  });
});

describe('RESUME-A1 R1 — real pdf-parse pipeline over synthetic layouts', () => {
  const POSITIVE: Record<string, string[]> = {
    'f01-table-label-value': [
      'TOOLS Jira, Confluence',
      'DATA & INTEGRATION Oracle, AWS Glue',
      'CERTIFICATIONS AWS Certified',
    ],
    'f02-right-aligned-date': [
      'EXAMPLE INFOTECH — SOFTWARE ENGINEER Mar 2008 – Jun 2011',
      'Bachelor of Engineering — Example University 1997',
    ],
    'f06-justified-words-no-space-chars': ['Led data modernization initiatives'],
    // Known limitation (R1.5): same-baseline columns stay line-interleaved; R1 only separates them.
    'f07-two-column-page': [
      'Left column line one Right column line one',
      'Left column line two Right column line two',
    ],
  };
  const NEGATIVE = [
    'f03-per-glyph-identifiers',
    'f04-letter-spaced-headings',
    'f05-font-change-midword',
    'f08-baseline-jitter',
    'f09-tight-gap-below-threshold',
  ];

  it.each(Object.entries(POSITIVE))('%s: separators restored', async (name, lines) => {
    const text = await extractResumeText(fixture(name));
    expect(text).not.toBeNull();
    expect((text as string).split('\n').filter((l) => l !== '')).toEqual(lines);
  });

  it.each(NEGATIVE)('%s: byte-identical to the pre-A1 renderer (no space inserted)', async (name) => {
    const buf = fixture(name);
    expect(await extractResumeText(buf)).toBe(await defaultPdfParseText(buf));
  });

  it('negative identifiers stay intact', async () => {
    const text = (await extractResumeText(fixture('f03-per-glyph-identifiers'))) as string;
    for (const id of ['jane.doe@example.com', 'https://git.io/a-b_c?x=1', 'v2.10.3', 'C#/.NET', 'U.S.', 'AZ-900', 'Node.js']) {
      expect(text.split('\n')).toContain(id);
    }
    const headings = (await extractResumeText(fixture('f04-letter-spaced-headings'))) as string;
    expect(headings.split('\n')).toEqual(['', '', 'SUMMARY', 'WORK EXPERIENCE']);
  });

  it.each([...Object.keys(POSITIVE), ...NEGATIVE, 'm01-three-page'])(
    '%s: R1.4 invariants — only whitespace changes; line count + order unchanged',
    async (name) => {
      const buf = fixture(name);
      const before = await defaultPdfParseText(buf);
      const after = (await extractResumeText(buf)) as string;
      expect(nonWhitespace(after)).toBe(nonWhitespace(before));
      const b = before.split('\n');
      const a = after.split('\n');
      expect(a).toHaveLength(b.length);
      a.forEach((line, i) => {
        if (line !== b[i]) expect(line.replace(/ /g, '')).toBe((b[i] as string).replace(/ /g, ''));
      });
    },
  );

  it.each([...Object.keys(POSITIVE), ...NEGATIVE, 'm01-three-page'])(
    '%s: deterministic over 5 parses (fixture validity gate)',
    async (name) => {
      const buf = fixture(name);
      const runs = await Promise.all([1, 2, 3, 4, 5].map(() => extractResumeText(buf)));
      expect(new Set(runs).size).toBe(1);
    },
  );
});

describe('RESUME-A1 R2 — fail closed on incomplete pages (real pdf-parse pipeline)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('control: a clean 3-page PDF reads completely', async () => {
    const text = await extractResumeText(fixture('m01-three-page'));
    expect(text).toBe(
      '\n\nSynthetic page 1 body text\n\nSynthetic page 2 body text\n\nSynthetic page 3 body text',
    );
  });

  it.each([
    ['c01-page2-resources-dangling', 2],
    ['c02-page3-contents-dangling', 3],
    ['m02-blank-page-2', 2],
  ])('%s → null (pre-A1 returned a partial read as success)', async (name, page) => {
    const buf = fixture(name);
    const partial = await defaultPdfParseText(buf);
    expect(nonWhitespace(partial).length).toBeGreaterThan(0); // the old silent-success hazard
    const warn = vi.spyOn(console, 'log');
    expect(await extractResumeText(buf)).toBeNull();
    const events = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('resume_text.pdf_incomplete'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0] as string)).toMatchObject({
      level: 'warn',
      event: 'resume_text.pdf_incomplete',
      reason: 'page_no_text',
      page_index: page,
      page_count: 3,
    });
  });

  it('induced render failure on page k inside the real pipeline → null (not swallowed)', async () => {
    const buf = fixture('m01-three-page');
    const warn = vi.spyOn(console, 'log');
    const text = await extractPdfText(buf, {
      beforePageRender: (n) => {
        if (n === 2) throw new Error('induced');
      },
    });
    expect(text).toBeNull();
    const event = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('pdf_incomplete'));
    expect(JSON.parse(event as string)).toMatchObject({ reason: 'page_render_failed', page_index: 2 });
  });

  it('diagnostics carry no document content (R2.5)', async () => {
    const warn = vi.spyOn(console, 'log');
    await extractResumeText(fixture('m02-blank-page-2'));
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('Synthetic');
    const record = JSON.parse(logged.split('\n').find((l) => l.includes('pdf_incomplete')) as string);
    expect(Object.keys(record).sort()).toEqual(
      ['context', 'event', 'level', 'page_count', 'page_index', 'reason', 'timestamp'].sort(),
    );
  });
});

describe('RESUME-A1 — A2 unchanged; attribution', () => {
  it('source-map version is still resume-source-map/v1 (A2 accepted unchanged)', () => {
    expect(RESUME_SOURCE_MAP_VERSION).toBe('resume-source-map/v1');
  });

  it('A2 invariants hold on corrected output', async () => {
    const text = (await extractResumeText(fixture('f01-table-label-value'))) as string;
    const map = buildResumeSourceMap(text);
    expect(map.blocks.map((b) => b.text)).toEqual([
      'TOOLS Jira, Confluence',
      'DATA & INTEGRATION Oracle, AWS Glue',
      'CERTIFICATIONS AWS Certified',
    ]);
    for (const b of map.blocks) expect(text.slice(b.char_start, b.char_end)).toBe(b.text);
  });

  it('extractor version identifies the A1 implementation (D-5)', () => {
    expect(RESUME_TEXT_EXTRACTOR_VERSION).toBe('resume-text-extractor/2');
  });
});
