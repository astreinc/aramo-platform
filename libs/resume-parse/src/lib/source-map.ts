import { createHash } from 'node:crypto';

// HF1 §3 / R1 — the canonical résumé source-map.
//
// resume-parse owns document-bytes → extracted-text, so it also owns the
// deterministic text → ordered-source-blocks transform. The source-map is the
// Aramo-OWNED corpus: grounding (in talent-extraction) resolves model-returned
// `source_refs` against these blocks and never trusts the model's reference
// alone (§5). It is passed BY VALUE through the controller seam into
// talent-extraction — talent-extraction does NOT import this lib (R1).
//
// Design constraints:
//   - DETERMINISTIC: identical text ⇒ byte-identical map (resume.ts never calls
//     Date/Math.random; the only entropy is the content itself).
//   - OFFSET INTEGRITY (§16): for every block, text.slice(char_start, char_end)
//     reproduces the block text verbatim — provenance maps back exactly.
//   - COMPACT REFERENCES: blocks are line-granular so a fact's source_refs is a
//     short list of ids (e.g. ["B004"]), never copied prose (§2/§11).

export const RESUME_SOURCE_MAP_VERSION = 'resume-source-map/v1';

export interface SourceMapBlock {
  /** Stable, ordered id within this map (e.g. "B004"). */
  readonly block_id: string;
  /** The trimmed block text — the grounding corpus for this block. */
  readonly text: string;
  /** Inclusive start offset of `text` in the original extracted text. */
  readonly char_start: number;
  /** Exclusive end offset of `text` in the original extracted text. */
  readonly char_end: number;
}

export interface ResumeSourceMap {
  /** Schema/algorithm version — persisted with provenance (§16). */
  readonly version: string;
  /** sha256 (hex) of the exact extracted text the map was built from. */
  readonly text_hash: string;
  /** Ordered, non-blank source blocks. */
  readonly blocks: readonly SourceMapBlock[];
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Left-pad the 1-based block number, widening past 3 digits only when a résumé
// is long enough to need it (keeps ids compact + stable for typical résumés).
function blockId(oneBasedIndex: number, total: number): string {
  const width = Math.max(3, String(total).length);
  return `B${String(oneBasedIndex).padStart(width, '0')}`;
}

/**
 * Build the canonical source-map for a résumé's extracted text. One block per
 * non-blank line; blank lines advance the offset cursor but emit no block.
 */
export function buildResumeSourceMap(text: string): ResumeSourceMap {
  const lines = text.split('\n');

  // First pass: collect content lines + their exact offsets (so we can size the
  // id width before assigning ids).
  const content: Array<{ trimmed: string; char_start: number; char_end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineStart = cursor;
    // Advance past this line + its '\n' (every split segment except the last
    // had a trailing newline in the original).
    cursor += line.length + (i < lines.length - 1 ? 1 : 0);

    const trimmed = line.trim();
    if (trimmed === '') continue;

    const leading = line.length - line.trimStart().length;
    const char_start = lineStart + leading;
    const char_end = char_start + trimmed.length;
    content.push({ trimmed, char_start, char_end });
  }

  const blocks: SourceMapBlock[] = content.map((c, idx) => ({
    block_id: blockId(idx + 1, content.length),
    text: c.trimmed,
    char_start: c.char_start,
    char_end: c.char_end,
  }));

  return {
    version: RESUME_SOURCE_MAP_VERSION,
    text_hash: sha256Hex(text),
    blocks,
  };
}
