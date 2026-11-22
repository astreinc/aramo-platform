import { Injectable, Logger } from '@nestjs/common';
import { TEXT_LAYER_MAX_PAGES, TEXT_LAYER_MAX_WORDS, extractTextLayer, wordsOfRun, type TextLayerPage, type TextLayerWord } from '@aramo/documents-rendering';

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

// FIELD-PARITY-1 P2-6 — the extractor itself (pdfjs-dist, words with 0..1 boxes) moved to
// @aramo/documents-rendering so the console's text-tag upload uses the same one; it is
// re-exported here unchanged for this service and its tests.

export { TEXT_LAYER_MAX_PAGES, TEXT_LAYER_MAX_WORDS, extractTextLayer, wordsOfRun, type TextLayerPage, type TextLayerWord };

export interface DocumentTextLayer {
  document_id: string;
  pages: TextLayerPage[];
}

const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_TOTAL_WORDS = 2_000_000;

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
