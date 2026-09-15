import { describe, expect, it } from 'vitest';

import {
  RESUME_SOURCE_MAP_VERSION,
  buildResumeSourceMap,
} from '../lib/source-map.js';

// HF1 §3 / R1 — the canonical résumé source-map. resume-parse owns
// document-bytes → extracted-text, so it also owns the deterministic
// text → ordered-source-blocks transform. The map is the Aramo-owned corpus
// that grounding (in talent-extraction) resolves model source_refs against;
// it must be DETERMINISTIC and its block offsets must map back EXACTLY to the
// original text (provenance integrity — §16).

const RESUME =
  'Sarah Nolan\n' +
  'Cloud Engineer — Austin, TX\n' +
  '\n' +
  '  Skills: C#, ASP.NET Core, Azure SQL  \n' +
  'Experience: Northstar Systems';

describe('buildResumeSourceMap — canonical deterministic source-map', () => {
  it('carries a stable version + content hash', () => {
    const map = buildResumeSourceMap(RESUME);
    expect(map.version).toBe(RESUME_SOURCE_MAP_VERSION);
    expect(map.text_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('is fully deterministic — identical text yields an identical map', () => {
    expect(buildResumeSourceMap(RESUME)).toEqual(buildResumeSourceMap(RESUME));
  });

  it('hash changes when the text changes, stable when it does not', () => {
    const a = buildResumeSourceMap(RESUME);
    const b = buildResumeSourceMap(RESUME + ' ');
    expect(a.text_hash).not.toBe(b.text_hash);
    expect(buildResumeSourceMap(RESUME).text_hash).toBe(a.text_hash);
  });

  it('emits one block per non-blank line, ids sequential B001…', () => {
    const map = buildResumeSourceMap(RESUME);
    expect(map.blocks.map((b) => b.block_id)).toEqual([
      'B001',
      'B002',
      'B003',
      'B004',
    ]);
    // The blank line produced NO block.
    expect(map.blocks).toHaveLength(4);
  });

  it('block text is trimmed; offsets map back EXACTLY to the original text', () => {
    const map = buildResumeSourceMap(RESUME);
    for (const block of map.blocks) {
      // The canonical invariant: slicing the original text by the recorded
      // offsets reproduces the block text verbatim (no drift).
      expect(RESUME.slice(block.char_start, block.char_end)).toBe(block.text);
    }
    // Specifically: the skills line was trimmed of its leading/trailing spaces.
    const skills = map.blocks.find((b) => b.text.startsWith('Skills:'));
    expect(skills?.text).toBe('Skills: C#, ASP.NET Core, Azure SQL');
  });

  it('empty text → no blocks, still a stable hash', () => {
    const map = buildResumeSourceMap('');
    expect(map.blocks).toEqual([]);
    expect(map.text_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
