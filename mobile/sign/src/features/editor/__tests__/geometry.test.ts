import {
  MIN_FIELD_HEIGHT,
  MIN_FIELD_WIDTH,
  centeredBox,
  clampBox,
  editorToScreenBox,
  editorToWire,
  isDrag,
  resizeBoxTo,
  scaleFor,
  screenToEditorBox,
  screenToEditorPoint,
  screenToWirePoint,
  wireBoxAccepted,
  wireToEditor,
} from '../geometry';

const LETTER = { width: 612, height: 792 };
const A4 = { width: 595.28, height: 841.89 };

// The web editor's transform (apps/sign-web/src/workspace/geometry.ts toPdf/toTopLeft):
// { x, y: pageHeight - y - height, width, height } in both directions.
function webToPdf(b: { x: number; y: number; width: number; height: number }, pageHeight: number) {
  return { x: b.x, y: pageHeight - b.y - b.height, width: b.width, height: b.height };
}

describe('field geometry (identical to the web editor and the server)', () => {
  it('converts the editor frame to the PDF-native wire frame like the web editor', () => {
    const editor = { x: 72, y: 642, width: 230, height: 50 };
    expect(editorToWire(editor, LETTER)).toEqual(webToPdf(editor, LETTER.height));
    // bottom-left origin: a box whose top is 642pt below the top edge has its lower-left
    // corner 100pt above the bottom edge.
    expect(editorToWire(editor, LETTER)).toEqual({ x: 72, y: 100, width: 230, height: 50 });
  });

  it('round-trips wire -> editor -> screen -> editor -> wire at every zoom', () => {
    const wire = { x: 300.25, y: 40.5, width: 150, height: 22 };
    for (const page of [LETTER, A4]) {
      for (const zoom of [1, 1.5, 2]) {
        const scale = scaleFor(page, 358 * zoom);
        const screen = editorToScreenBox(wireToEditor(wire, page), scale);
        const back = editorToWire(screenToEditorBox(screen, scale), page);
        expect(back).toEqual(wire);
      }
    }
  });

  it('maps a tap on the rendered page to PDF points with a bottom-left origin', () => {
    // Letter rendered 306dp wide => 0.5 dp per point.
    expect(scaleFor(LETTER, 306)).toBe(0.5);
    expect(screenToEditorPoint({ x: 153, y: 198 }, 0.5)).toEqual({ x: 306, y: 396 });
    // The top-left corner of the view is (0, page height) on the wire.
    expect(screenToWirePoint({ x: 0, y: 0 }, LETTER, 306)).toEqual({ x: 0, y: 792 });
    expect(screenToWirePoint({ x: 306, y: 396 }, LETTER, 306)).toEqual({ x: 612, y: 0 });
  });

  it('rounds to the two decimals the server stores', () => {
    const w = editorToWire({ x: 10.123456, y: 20.987654, width: 33.3333, height: 12.005 }, LETTER);
    expect(w.x).toBe(10.12);
    expect(w.width).toBe(33.33);
    expect(w.height).toBe(12.01);
    expect(w.y).toBe(Math.round((792 - 20.987654 - 12.005) * 100) / 100);
  });

  it('produces boxes the server accepts (inside the page, positive size)', () => {
    // The server refuses x+width > page width + 0.5 and y+height > page height + 0.5.
    const corner = clampBox({ x: 9999, y: 9999, width: 230, height: 50 }, A4);
    const wire = editorToWire(corner, A4);
    expect(wireBoxAccepted(wire, A4)).toBe(true);
    expect(wire.x + wire.width).toBeLessThanOrEqual(A4.width + 0.5);
    expect(wire.y).toBe(0);
    expect(wireBoxAccepted({ x: 600, y: 0, width: 20, height: 10 }, LETTER)).toBe(false);
    expect(wireBoxAccepted({ x: 0, y: -1, width: 20, height: 10 }, LETTER)).toBe(false);
    expect(wireBoxAccepted({ x: 0, y: 0, width: 0, height: 10 }, LETTER)).toBe(false);
  });

  it('places centred on the tap and keeps the box inside the page', () => {
    expect(centeredBox({ x: 306, y: 396 }, { width: 230, height: 50 }, LETTER)).toEqual({
      x: 191,
      y: 371,
      width: 230,
      height: 50,
    });
    // Near the top-left corner the box is pushed inside.
    expect(centeredBox({ x: 5, y: 5 }, { width: 230, height: 50 }, LETTER)).toEqual({
      x: 0,
      y: 0,
      width: 230,
      height: 50,
    });
  });

  it('resizes from the bottom-right handle down to 14×12 and never past the page edge', () => {
    const b = { x: 500, y: 700, width: 60, height: 30 };
    expect(resizeBoxTo(b, { width: 1, height: 1 }, LETTER)).toEqual({
      x: 500,
      y: 700,
      width: MIN_FIELD_WIDTH,
      height: MIN_FIELD_HEIGHT,
    });
    expect(resizeBoxTo(b, { width: 500, height: 500 }, LETTER)).toEqual({
      x: 500,
      y: 700,
      width: 112,
      height: 92,
    });
  });

  it('starts a drag only after 4px of movement', () => {
    expect(isDrag(3, 0)).toBe(false);
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(4, 0)).toBe(true);
    expect(isDrag(3, 3)).toBe(true);
  });
});
