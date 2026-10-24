// PLATFORM-UX-1 F-9 (handoff §10.7 Preview) — client-ESTIMATED A4 page breaks. Exact PDF
// pagination is a data gap (directive R-13): the server renders the PDF; the Studio only
// estimates where pages break, with the design file's own estimate
// (Template Studio.dc.html enterPreview): a 794×1123 page holds ~860px of body, page 1
// starts 70px down (the H1 title), a block is 28px + 24px per ~88 characters.

export const PAGE_BODY_PX = 860;
export const FIRST_PAGE_OFFSET_PX = 70;
const CHARS_PER_LINE = 88;
const LINE_PX = 24;
const BLOCK_PX = 28;

export function estimateBlockHeight(text: string): number {
  return BLOCK_PX + Math.ceil(text.length / CHARS_PER_LINE) * LINE_PX;
}

/** Group block indices into pages. Always at least one (possibly empty) page. */
export function paginate(texts: readonly string[]): number[][] {
  const pages: number[][] = [[]];
  let h = FIRST_PAGE_OFFSET_PX;
  texts.forEach((t, i) => {
    const bh = estimateBlockHeight(t);
    const cur = pages[pages.length - 1] as number[];
    if (h + bh > PAGE_BODY_PX && cur.length > 0) {
      pages.push([i]);
      h = bh;
      return;
    }
    cur.push(i);
    h += bh;
  });
  return pages;
}

export const ZOOM_MIN = 60;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 10;

export function zoomIn(z: number): number {
  return Math.min(ZOOM_MAX, z + ZOOM_STEP);
}
export function zoomOut(z: number): number {
  return Math.max(ZOOM_MIN, z - ZOOM_STEP);
}
