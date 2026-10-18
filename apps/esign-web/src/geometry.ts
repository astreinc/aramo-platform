// Editor geometry — pure helpers (no renderer). The editor works in a TOP-LEFT
// frame in PDF points; the wire and the execution stamper use the PDF-native
// BOTTOM-LEFT frame with (x, y) the box's lower-left corner.

export interface PdfPageInfo {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// PDF (bottom-left, y = box bottom) → editor (top-left, y = box top).
export function toTopLeft(b: Box, pageHeight: number): Box {
  return { x: b.x, y: pageHeight - b.y - b.height, width: b.width, height: b.height };
}

// Editor (top-left) → PDF (bottom-left). The same transform; it is its own inverse.
export function toPdf(b: Box, pageHeight: number): Box {
  return { x: b.x, y: pageHeight - b.y - b.height, width: b.width, height: b.height };
}

// Keeps a box inside its page.
export function clampBox(b: Box, page: PdfPageInfo): Box {
  const width = Math.max(14, Math.min(b.width, page.width));
  const height = Math.max(14, Math.min(b.height, page.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(page.width - width, b.x)),
    y: Math.max(0, Math.min(page.height - height, b.y)),
  };
}
