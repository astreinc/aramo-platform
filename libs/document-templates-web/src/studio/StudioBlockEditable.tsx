import { memo, useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';

import { isStudioTextKind, studioInsertAtRange, type StudioBlock, type StudioCodec as BlockCodec } from '../studio-codec';

// PLATFORM-UX-1 F-9 (directive R-11) — ONE editable region per block, through the
// in-house codec. The DOM is the browser's while typing (the caret never jumps); React
// re-renders it only when the block value / kind / codec changes from OUTSIDE (undo,
// turn into, restore, a chip removed from Checks) — detected by comparing the serialised
// DOM with the block value, exactly like the RTR editor's BlockBox. No
// document.execCommand; no innerHTML: the codec builds the DOM node by node.

const NO_MAP = { labelByToken: {}, tokenByLabel: {} };

export const KIND_LABEL: Readonly<Record<StudioBlock['kind'], string>> = {
  p: 'Paragraph',
  h2: 'Heading',
  h3: 'Subheading',
  h4: 'Small heading',
  ul: 'Bulleted list',
  ol: 'Numbered list',
  table: 'Table',
  hr: 'Divider',
  page_break: 'Page break',
};

const PLACEHOLDER: Partial<Record<StudioBlock['kind'], string>> = { h2: 'Heading', h3: 'Subheading', h4: 'Small heading' };

export interface StudioBlockEditableProps {
  readonly block: StudioBlock;
  readonly codec: BlockCodec;
  readonly register: (id: string, el: HTMLDivElement | null) => void;
  readonly onValue: (id: string, value: string) => void;
  readonly onKey: (e: KeyboardEvent<HTMLDivElement>, block: StudioBlock, el: HTMLDivElement) => void;
  readonly onKeyUpBlock: (e: KeyboardEvent<HTMLDivElement>, block: StudioBlock, el: HTMLDivElement) => void;
  readonly onFocusBlock: (id: string) => void;
  readonly onPasted: () => void;
}

export const StudioBlockEditable = memo(function StudioBlockEditable({
  block,
  codec,
  register,
  onValue,
  onKey,
  onKeyUpBlock,
  onFocusBlock,
  onPasted,
}: StudioBlockEditableProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rendered = useRef<{ kind: string; codec: BlockCodec } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const r = rendered.current;
    if (r === null || r.kind !== block.kind || r.codec !== codec || codec.serialize(el, NO_MAP, block.kind) !== block.value) {
      codec.render(el, block.value, NO_MAP, block.kind);
      rendered.current = { kind: block.kind, codec };
    }
  }, [block.value, block.kind, codec]);

  const sync = (): void => {
    const el = ref.current;
    if (el !== null) onValue(block.id, codec.serialize(el, NO_MAP, block.kind));
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const el = ref.current;
    if (el === null) return;
    const nodes = codec.pasteNodes(e.clipboardData ?? null, NO_MAP);
    if (nodes.length === 0) return;
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    studioInsertAtRange(el, sel !== null && sel.rangeCount > 0 ? sel.getRangeAt(0) : null, nodes);
    sync();
    onPasted();
  };

  // Drops of outside content (rich HTML from another page) are refused: paste is the
  // sanitised path. Studio drags (blocks, rows, variables) are handled by the row.
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
  };

  // TEMPLATE-CONTENT-2 (C-13) — a table is a group of editable cells (the codec draws them;
  // its structure is never typed into); a divider / page break is one focusable separator
  // (Backspace or Delete removes it, Enter adds a paragraph below). Events from the cells
  // bubble to this element, so input, paste and keys go through the same handlers.
  const textual = isStudioTextKind(block.kind);
  const role = textual ? 'textbox' : block.kind === 'table' ? 'group' : 'separator';

  return (
    <div
      ref={(el) => {
        ref.current = el;
        register(block.id, el);
      }}
      className={`pws-blk pws-blk--${block.kind}`}
      contentEditable={textual}
      suppressContentEditableWarning
      role={role}
      aria-multiline={textual ? 'true' : undefined}
      aria-label={KIND_LABEL[block.kind]}
      tabIndex={block.kind === 'table' ? -1 : 0}
      spellCheck={textual || block.kind === 'table'}
      data-block-id={block.id}
      data-placeholder={textual ? (PLACEHOLDER[block.kind] ?? 'Type / for blocks, {{ for variables') : undefined}
      onInput={sync}
      onBlur={sync}
      onKeyDown={(e) => {
        if (ref.current !== null) onKey(e, block, ref.current);
      }}
      onKeyUp={(e) => {
        if (ref.current !== null) onKeyUpBlock(e, block, ref.current);
      }}
      onFocus={() => onFocusBlock(block.id)}
      onPaste={onPaste}
      onDrop={onDrop}
    />
  );
});
