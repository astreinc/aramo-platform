import { memo, useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';

import { studioInsertAtRange, type StudioBlock, type StudioCodec as BlockCodec } from '../studio-codec';

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
  ul: 'Bulleted list',
  ol: 'Numbered list',
};

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

  return (
    <div
      ref={(el) => {
        ref.current = el;
        register(block.id, el);
      }}
      className={`pws-blk pws-blk--${block.kind}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={KIND_LABEL[block.kind]}
      tabIndex={0}
      spellCheck
      data-block-id={block.id}
      data-placeholder={block.kind === 'h2' ? 'Heading' : 'Type / for blocks, {{ for variables'}
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
