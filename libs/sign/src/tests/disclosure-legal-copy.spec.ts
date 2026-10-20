import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_DISCLOSURE_VERSION, DISCLOSURE_V2_TEXT, currentDisclosure, findDisclosure, listDisclosures } from '../lib/domain/disclosure.js';

// Commercial Plans Amendment A1 §3.C — the signer disclosure served as v2 is the
// SAME text as the legal draft under review, every version stays LEGAL_PENDING
// until approved, and v1 stays the default until the switch is authorized.

const DOC = resolve(__dirname, '../../../../doc/legal/aramo-sign/esign-consent-disclosure.md');

function draftText(): string {
  const md = readFileSync(DOC, 'utf8');
  const section = md.slice(md.indexOf('## Text shown to the signer'));
  const parts = section.split(/^---$/m);
  return parts[1]!
    .replace(/\*\*/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/(You acknowledge that:)\n\n/, '$1\n');
}

describe('signer disclosure versions', () => {
  it('v2 is byte-for-byte the legal draft text', () => {
    expect(DISCLOSURE_V2_TEXT).toBe(draftText());
  });

  it('every version is LEGAL_PENDING (nothing approved yet); v1 stays the default', () => {
    expect(listDisclosures().map((d) => [d.version, d.legal_status])).toEqual([
      ['v1', 'LEGAL_PENDING'],
      ['v2', 'LEGAL_PENDING'],
    ]);
    expect(CURRENT_DISCLOSURE_VERSION).toBe('v1');
    expect(currentDisclosure({}).version).toBe('v1');
  });

  it('SIGN_DISCLOSURE_VERSION selects a registered version and never an unknown one', () => {
    expect(currentDisclosure({ SIGN_DISCLOSURE_VERSION: 'v2' }).version).toBe('v2');
    expect(currentDisclosure({ SIGN_DISCLOSURE_VERSION: 'v9' }).version).toBe('v1');
    expect(findDisclosure('v2')?.text_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
