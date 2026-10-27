import {
  appendStudioVariable,
  convertStudioValue,
  removeStudioVariable,
  studioValueFromText,
  type StudioBlock,
  type StudioBlockKind,
  type StudioLetterheadBlock,
} from '../studio-codec';

// PLATFORM-UX-1 F-9 (handoff §10.4) — pure block-list operations of the Studio canvas:
// insert, move (drag and drop, ⌥↑/⌥↓, block menu), turn into, duplicate, delete,
// variable append / removal. Every op returns a NEW list (the undo history keeps the old).

export interface StudioDoc {
  readonly title: string;
  readonly blocks: readonly StudioBlock[];
  /**
   * TEMPLATE-STUDIO-1 — the tenant letterhead (A1), carried beside the editable blocks so
   * every save re-encodes it (the data source's content codec). Absent on the platform.
   */
  readonly letterhead?: StudioLetterheadBlock | null;
}

let seq = 0;
/** A client-only block id (never stored). */
export function newBlockId(): string {
  seq += 1;
  return `blk-${seq}`;
}

export function makeBlock(kind: StudioBlockKind, value = ''): StudioBlock {
  return { id: newBlockId(), kind, value: kind === 'ul' || kind === 'ol' ? value || '<li></li>' : value };
}

export function blockFromText(kind: StudioBlockKind, text: string): StudioBlock {
  return { id: newBlockId(), kind, value: studioValueFromText(kind, text) };
}

/** Insert `add` after the block `afterId` (or at the end); `before` inserts above it. */
export function insertBlocks(blocks: readonly StudioBlock[], add: readonly StudioBlock[], afterId?: string | null, before = false): StudioBlock[] {
  const out = [...blocks];
  let idx = afterId ? out.findIndex((b) => b.id === afterId) : -1;
  if (idx < 0) idx = out.length - 1;
  else if (before) idx -= 1;
  out.splice(idx + 1, 0, ...add);
  return out;
}

/** Move `id` before / after `targetId`. A no-op when they are the same block. */
export function moveBlock(blocks: readonly StudioBlock[], id: string, targetId: string | null, pos: 'before' | 'after'): StudioBlock[] {
  if (id === targetId) return [...blocks];
  const out = [...blocks];
  const i = out.findIndex((b) => b.id === id);
  if (i < 0) return out;
  const [m] = out.splice(i, 1);
  if (m === undefined) return out;
  if (targetId === null) {
    out.push(m);
    return out;
  }
  let j = out.findIndex((b) => b.id === targetId);
  if (j < 0) j = out.length;
  else if (pos === 'after') j += 1;
  out.splice(j, 0, m);
  return out;
}

/** Swap with the neighbour above (-1) or below (+1). */
export function shiftBlock(blocks: readonly StudioBlock[], id: string, dir: -1 | 1): StudioBlock[] {
  const out = [...blocks];
  const i = out.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= out.length) return out;
  const a = out[i] as StudioBlock;
  out[i] = out[j] as StudioBlock;
  out[j] = a;
  return out;
}

export function setBlockKind(blocks: readonly StudioBlock[], id: string, kind: StudioBlockKind): StudioBlock[] {
  return blocks.map((b) => (b.id === id && b.kind !== kind ? { ...b, kind, value: convertStudioValue(b.value, b.kind, kind) } : b));
}

export function setBlockValue(blocks: readonly StudioBlock[], id: string, value: string): StudioBlock[] {
  return blocks.map((b) => (b.id === id ? { ...b, value } : b));
}

export function duplicateBlock(blocks: readonly StudioBlock[], id: string): StudioBlock[] {
  const b = blocks.find((x) => x.id === id);
  if (b === undefined) return [...blocks];
  return insertBlocks(blocks, [{ id: newBlockId(), kind: b.kind, value: b.value }], id);
}

export function deleteBlock(blocks: readonly StudioBlock[], id: string): StudioBlock[] {
  return blocks.filter((b) => b.id !== id);
}

/** Remove every chip for `key` across the draft (the Checks "Remove from draft" fix). */
export function removeVariableEverywhere(blocks: readonly StudioBlock[], key: string): StudioBlock[] {
  return blocks.map((b) => (b.value.includes(`data-field="${key}"`) ? { ...b, value: removeStudioVariable(b.kind, b.value, key) } : b));
}

/** Append a chip for `key` to the block `id`. */
export function appendVariable(blocks: readonly StudioBlock[], id: string, key: string): StudioBlock[] {
  return blocks.map((b) => (b.id === id ? { ...b, value: appendStudioVariable(b.kind, b.value, key) } : b));
}

/** Fresh ids for a copied block list (version restore, copy published version). */
export function cloneBlocks(blocks: readonly Pick<StudioBlock, 'kind' | 'value'>[]): StudioBlock[] {
  return blocks.map((b) => ({ id: newBlockId(), kind: b.kind, value: b.value }));
}
