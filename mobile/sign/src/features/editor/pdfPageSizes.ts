// Page sizes (PDF points) read straight from a PDF's bytes, so the editor can place
// fields before the document is uploaded (offline preparation, directive §9) and for
// drafts prepared elsewhere (the sender detail does not carry page geometry).
//
// The size is the MediaBox width / height, the box pdf-lib's page.getWidth() /
// getHeight() report, which the server validates field boxes against and the stamper
// draws in. Handles classic and incremental files and compressed object streams
// (FlateDecode). Anything it cannot read is an error; the caller then falls back to the
// sizes the upload response reports.
import { inflate } from './inflate';
import type { PageSize } from './geometry';

const MAX_PAGES = 5000;

function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  }
  return out;
}

function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** True when the bytes start like a PDF (`%PDF-` within the first 1024 bytes). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, Math.min(bytes.length, 1024))).includes('%PDF-');
}

interface ParsedObjects {
  readonly objects: Map<number, string>;
  readonly roots: number[];
}

function parseObjects(text: string): ParsedObjects {
  const objects = new Map<number, string>();
  const roots: number[] = [];
  const head = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text)) !== null) {
    const num = Number(m[1]);
    const bodyStart = head.lastIndex;
    const endobjAt = text.indexOf('endobj', bodyStart);
    if (endobjAt < 0) break;
    const streamAt = findStreamKeyword(text.slice(bodyStart, endobjAt));
    if (streamAt >= 0) {
      const dict = text.slice(bodyStart, bodyStart + streamAt);
      let dataStart = bodyStart + streamAt + 'stream'.length;
      if (text.charAt(dataStart) === '\r') dataStart += 1;
      if (text.charAt(dataStart) === '\n') dataStart += 1;
      const len = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = len ? dataStart + Number(len[1]) : -1;
      if (dataEnd < 0 || text.slice(dataEnd, dataEnd + 30).indexOf('endstream') < 0) {
        dataEnd = text.indexOf('endstream', dataStart);
        if (dataEnd < 0) break;
      }
      objects.set(num, dict);
      if (/\/Type\s*\/ObjStm\b/.test(dict))
        expandObjectStream(dict, text.slice(dataStart, dataEnd), objects);
      if (/\/Type\s*\/XRef\b/.test(dict)) collectRoot(dict, roots);
      const after = text.indexOf('endobj', dataEnd);
      head.lastIndex = after < 0 ? text.length : after + 6;
    } else {
      objects.set(num, text.slice(bodyStart, endobjAt));
      head.lastIndex = endobjAt + 6;
    }
  }
  const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/g;
  while ((m = trailer.exec(text)) !== null) collectRoot(m[1] ?? '', roots);
  return { objects, roots };
}

/** Offset of the `stream` keyword that follows the object's dictionary, or -1. */
function findStreamKeyword(body: string): number {
  const m = />>\s*stream(?=\r?\n)/.exec(body);
  return m ? m.index + m[0].length - 'stream'.length : -1;
}

function collectRoot(dict: string, roots: number[]): void {
  const r = /\/Root\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (r) roots.push(Number(r[1]));
}

function expandObjectStream(dict: string, raw: string, objects: Map<number, string>): void {
  const filter = /\/Filter\s*(\[\s*)?\/(\w+)/.exec(dict)?.[2];
  let content: string;
  if (filter === undefined) content = raw;
  else if (filter === 'FlateDecode') content = latin1(inflate(toBytes(raw)));
  else return; // other filters are not used for object streams in practice
  const n = Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? NaN);
  const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? NaN);
  if (!Number.isInteger(n) || !Number.isInteger(first)) return;
  const nums = content.slice(0, first).trim().split(/\s+/).map(Number);
  for (let i = 0; i < n; i += 1) {
    const num = nums[2 * i];
    const off = nums[2 * i + 1];
    if (num === undefined || off === undefined || !Number.isFinite(num) || !Number.isFinite(off))
      continue;
    const nextOff = nums[2 * i + 3];
    const end =
      nextOff !== undefined && Number.isFinite(nextOff) ? first + nextOff : content.length;
    objects.set(num, content.slice(first + off, end));
  }
}

function ref(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
}

function numberArray(s: string): number[] | null {
  const nums = s
    .trim()
    .split(/\s+/)
    .filter((x) => x.length > 0)
    .map(Number);
  return nums.length === 4 && nums.every(Number.isFinite) ? nums : null;
}

function mediaBox(dict: string, objects: Map<number, string>): PageSize | null {
  const direct = /\/MediaBox\s*\[([^\]]*)\]/.exec(dict);
  let arr: number[] | null = direct ? numberArray(direct[1] ?? '') : null;
  if (!arr) {
    const r = ref(dict, 'MediaBox');
    const body = r !== null ? objects.get(r) : undefined;
    const inner = body ? /\[([^\]]*)\]/.exec(body) : null;
    arr = inner ? numberArray(inner[1] ?? '') : null;
  }
  if (!arr) return null;
  const [x1, y1, x2, y2] = arr as [number, number, number, number];
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return width > 0 && height > 0 ? { width, height } : null;
}

function kids(dict: string, objects: Map<number, string>): number[] {
  let arr = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1];
  if (arr === undefined) {
    const r = ref(dict, 'Kids');
    const body = r !== null ? objects.get(r) : undefined;
    arr = body ? /\[([^\]]*)\]/.exec(body)?.[1] : undefined;
  }
  if (arr === undefined) return [];
  return [...arr.matchAll(/(\d+)\s+\d+\s+R/g)].map((k) => Number(k[1]));
}

const IS_PAGES = /\/Type\s*\/Pages\b/;
const IS_PAGE = /\/Type\s*\/Page(?![A-Za-z])/;

/** Page sizes in document order. Throws when the page tree can't be read. */
export function readPdfPageSizes(bytes: Uint8Array): PageSize[] {
  if (!looksLikePdf(bytes)) throw new Error('not a PDF');
  const text = latin1(bytes);
  if (/\/Encrypt\s/.test(text)) throw new Error('encrypted PDF');
  const { objects, roots } = parseObjects(text);
  let catalog: string | undefined;
  for (let i = roots.length - 1; i >= 0 && catalog === undefined; i -= 1) {
    const c = objects.get(roots[i]!);
    if (c && /\/Type\s*\/Catalog\b/.test(c)) catalog = c;
  }
  catalog ??= [...objects.values()].reverse().find((o) => /\/Type\s*\/Catalog\b/.test(o));
  if (!catalog) throw new Error('no catalog');
  const pagesRoot = ref(catalog, 'Pages');
  if (pagesRoot === null) throw new Error('no page tree');

  const out: PageSize[] = [];
  const seen = new Set<number>();
  const walk = (num: number, inherited: PageSize | null): void => {
    if (seen.has(num) || out.length > MAX_PAGES) throw new Error('bad page tree');
    seen.add(num);
    const dict = objects.get(num);
    if (dict === undefined) throw new Error('missing page object');
    const box = mediaBox(dict, objects) ?? inherited;
    if (IS_PAGES.test(dict) || (!IS_PAGE.test(dict) && /\/Kids\b/.test(dict))) {
      for (const k of kids(dict, objects)) walk(k, box);
      return;
    }
    if (!box) throw new Error('page without MediaBox');
    out.push(box);
  };
  walk(pagesRoot, null);
  if (out.length === 0) throw new Error('no pages');
  return out;
}
