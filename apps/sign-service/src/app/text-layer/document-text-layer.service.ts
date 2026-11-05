import { Injectable, Logger } from '@nestjs/common';

// Aramo Sign Mobile M-A12 §2 W1-C.2 — "Find in document". The server extracts each page's
// words, with boxes normalised to 0..1 of the page (origin top-left), from the stored PDF
// bytes. The device searches and highlights; the server never sees the query.
//
//   Library   pdfjs-dist (already a production dependency of the workspace, used by the
//             document-templates web viewer) through its Node "legacy" build. No new
//             dependency. pdf-lib (used for page sizes) has no text extraction.
//   Cache     in memory, per document VERSION (the stored source sha256, or the frozen
//             Documents revision), bounded (entries and words). Nothing is persisted, so
//             the text layer never outlives the document (draft delete, retention purge).
//   Privacy   the extracted text is never logged: failures log the document id and the
//             error class only.
//   Image-only PDF  every page is returned with `words: []`. An unreadable PDF returns
//             `pages: []` (the device shows "No searchable text in this document").

export interface TextLayerWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLayerPage {
  page: number;
  words: TextLayerWord[];
}

export interface DocumentTextLayer {
  document_id: string;
  pages: TextLayerPage[];
}

// Bounds: a pathological PDF never pins the process or the cache.
export const TEXT_LAYER_MAX_PAGES = 2000;
export const TEXT_LAYER_MAX_WORDS = 250_000;
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_TOTAL_WORDS = 2_000_000;

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
}

interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocLike> };
  Util: { transform(a: number[], b: number[]): number[] };
}

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
    getTextContent(): Promise<{ items: unknown[] }>;
    cleanup?: () => void;
  }>;
  destroy(): Promise<void>;
}

let pdfjsModule: Promise<PdfjsLike> | null = null;

function loadPdfjs(): Promise<PdfjsLike> {
  // The Node build of pdfjs-dist is ESM-only: a dynamic import (kept as import() by the
  // nodenext compiler) loads it on first use.
  pdfjsModule ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsLike>;
  return pdfjsModule;
}

const round = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;

/** Splits one text run into words with boxes, apportioning the run by character position. */
export function wordsOfRun(str: string, tx: readonly number[], runWidth: number, pageWidth: number, pageHeight: number): TextLayerWord[] {
  const len = str.length;
  if (len === 0 || pageWidth <= 0 || pageHeight <= 0) return [];
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = tx;
  // Direction of the text baseline in viewport space, and the "up" vector (font height).
  const scale = Math.hypot(a, b);
  const dir = scale > 0 ? [a / scale, b / scale] : [1, 0];
  const up = [c, d];
  const out: TextLayerWord[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const start = (m.index / len) * runWidth;
    const end = ((m.index + m[0].length) / len) * runWidth;
    const p0 = [e + (dir[0] ?? 0) * start, f + (dir[1] ?? 0) * start];
    const p1 = [e + (dir[0] ?? 0) * end, f + (dir[1] ?? 0) * end];
    const corners = [p0, p1, [(p0[0] ?? 0) + (up[0] ?? 0), (p0[1] ?? 0) + (up[1] ?? 0)], [(p1[0] ?? 0) + (up[0] ?? 0), (p1[1] ?? 0) + (up[1] ?? 0)]];
    const xs = corners.map((p) => p[0] ?? 0);
    const ys = corners.map((p) => p[1] ?? 0);
    const x0 = Math.min(...xs) / pageWidth;
    const x1 = Math.max(...xs) / pageWidth;
    const y0 = Math.min(...ys) / pageHeight;
    const y1 = Math.max(...ys) / pageHeight;
    const x = round(x0);
    const y = round(y0);
    out.push({ t: m[0], x, y, w: round(round(x1) - x), h: round(round(y1) - y) });
  }
  return out;
}

/** Extracts every page's words. Throws when the bytes are not a readable PDF. */
export async function extractTextLayer(bytes: Uint8Array): Promise<TextLayerPage[]> {
  const pdfjs = await loadPdfjs();
  // pdfjs takes ownership of (and may detach) the buffer it is given: pass a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  try {
    const pages: TextLayerPage[] = [];
    let total = 0;
    const count = Math.min(doc.numPages, TEXT_LAYER_MAX_PAGES);
    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const words: TextLayerWord[] = [];
      if (total < TEXT_LAYER_MAX_WORDS) {
        const content = await page.getTextContent();
        for (const raw of content.items) {
          const item = raw as PdfTextItem;
          if (typeof item.str !== 'string' || item.str.trim().length === 0 || !Array.isArray(item.transform)) continue;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const runWidth = (item.width ?? 0) * Math.hypot(viewport.transform[0] ?? 1, viewport.transform[1] ?? 0);
          for (const w of wordsOfRun(item.str, tx, runWidth, viewport.width, viewport.height)) {
            if (total >= TEXT_LAYER_MAX_WORDS) break;
            words.push(w);
            total += 1;
          }
        }
      }
      page.cleanup?.();
      pages.push({ page: n, words });
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

@Injectable()
export class DocumentTextLayerService {
  private readonly log = new Logger(DocumentTextLayerService.name);
  private readonly cache = new Map<string, TextLayerPage[]>();
  private readonly inflight = new Map<string, Promise<TextLayerPage[]>>();
  private cachedWords = 0;
  // The extractor (replaceable in tests). No constructor parameters: Nest builds it as is.
  extract: (bytes: Uint8Array) => Promise<TextLayerPage[]> = extractTextLayer;

  /** The text layer of one document version; `load` fetches the bytes on a cache miss. */
  async forDocument(document_id: string, version: string, load: () => Promise<Uint8Array>): Promise<DocumentTextLayer> {
    const key = `${document_id}:${version}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // LRU: a hit moves to the newest position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { document_id, pages: hit };
    }
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = this.compute(document_id, load).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const pages = await pending;
    this.remember(key, pages);
    return { document_id, pages };
  }

  private async compute(document_id: string, load: () => Promise<Uint8Array>): Promise<TextLayerPage[]> {
    const bytes = await load();
    try {
      return await this.extract(bytes);
    } catch (e) {
      // Never the message or any content: only which document and the error class.
      this.log.warn(`text layer unavailable for document ${document_id} (${e instanceof Error ? e.name : 'error'})`);
      return [];
    }
  }

  private remember(key: string, pages: TextLayerPage[]): void {
    if (this.cache.has(key)) return;
    const words = pages.reduce((n, p) => n + p.words.length, 0);
    if (words > CACHE_MAX_TOTAL_WORDS) return;
    this.cache.set(key, pages);
    this.cachedWords += words;
    while (this.cache.size > CACHE_MAX_ENTRIES || this.cachedWords > CACHE_MAX_TOTAL_WORDS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cachedWords -= this.cache.get(oldest)?.reduce((n, p) => n + p.words.length, 0) ?? 0;
      this.cache.delete(oldest);
    }
  }
}
