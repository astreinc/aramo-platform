import { Injectable, Logger } from '@nestjs/common';
import { extractPageGraphics, readPageFrames, type PageGraphics } from '@aramo/documents-rendering';
import { fieldTypesFor } from '@aramo/sign-fields';

import { DocumentTextLayerService } from './document-text-layer.service.js';
import { type DetectedField, type FieldSuggestion, type PageFrame, type SkippedPage, detectFields, suggestFields } from './field-suggestions.js';

// Aramo Sign Mobile M-A14 R-3 / §2 — GET .../documents/{documentId}/field-suggestions.
// Reuses the M-A12 text layer (same cache, per document version) and reads each page's
// geometry with pdf-lib (already used for page sizes), cached per version as well. No model
// and no outbound call: the document never leaves the platform. Every failure after the
// caller's visibility check is an empty list (the feature is a convenience), and only the
// document id and the error class are logged — never any text.
//
// FIELD-PARITY-1 §5 P2-4 — `detect: 'all'` runs the shared detector (@aramo/sign-fields
// detectFields) over the text layer AND the page's drawn rectangles (empty boxes, ruled table
// cells; read with the same pdfjs build, cached per version), limited to the types the sender
// may place (the catalog's send surfaces). Without it the answer is exactly the M-A14 one.

const FRAME_CACHE_MAX = 64;
const GRAPHICS_CACHE_MAX = 32;

// FIELD-PARITY-1 P2-6 — the page-frame reader moved to @aramo/documents-rendering (one copy,
// shared with the text-tag upload); re-exported unchanged.
export { readPageFrames };

export type SuggestionMode = 'signature_block' | 'all';

export interface AllSuggestions {
  suggestions: DetectedField[];
  skipped_pages: SkippedPage[];
}

// The types a sender may place from sign-web or the app (both surfaces are the same set).
const SENDER_TYPES = fieldTypesFor('send_web');

function remember<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

@Injectable()
export class FieldSuggestionsService {
  private readonly log = new Logger(FieldSuggestionsService.name);
  private readonly frames = new Map<string, PageFrame[]>();
  private readonly graphics = new Map<string, PageGraphics[]>();
  // Replaceable in tests. No constructor parameters beyond the text layer.
  readFrames: (bytes: Uint8Array) => Promise<PageFrame[]> = readPageFrames;
  readGraphics: (bytes: Uint8Array) => Promise<PageGraphics[]> = extractPageGraphics;

  constructor(private readonly textLayer: DocumentTextLayerService) {}

  async suggest(document_id: string, version: string, load: () => Promise<Uint8Array>): Promise<{ suggestions: FieldSuggestion[] }>;
  async suggest(document_id: string, version: string, load: () => Promise<Uint8Array>, mode: 'all'): Promise<AllSuggestions>;
  async suggest(document_id: string, version: string, load: () => Promise<Uint8Array>, mode: SuggestionMode = 'signature_block'): Promise<{ suggestions: FieldSuggestion[] } | AllSuggestions> {
    const empty = mode === 'all' ? { suggestions: [], skipped_pages: [] } : { suggestions: [] };
    try {
      // One byte fetch at most per call, shared by the text layer, the frames and the drawing.
      let bytes: Promise<Uint8Array> | undefined;
      const once = (): Promise<Uint8Array> => (bytes ??= load());
      const layer = await this.textLayer.forDocument(document_id, version, once);
      const key = `${document_id}:${version}`;
      if (mode !== 'all' && !layer.pages.some((p) => p.words.length > 0)) return empty;
      let frames = this.frames.get(key);
      if (frames === undefined) {
        frames = await this.readFrames(await once());
        remember(this.frames, key, frames, FRAME_CACHE_MAX);
      }
      if (mode !== 'all') return { suggestions: suggestFields(layer.pages, frames) };
      let graphics = this.graphics.get(key);
      if (graphics === undefined) {
        // A drawing that cannot be read leaves the text rules working.
        graphics = await this.readGraphics(await once()).catch((e: unknown) => {
          this.log.warn(`page drawing unavailable for document ${document_id} (${e instanceof Error ? e.name : 'error'})`);
          return [] as PageGraphics[];
        });
        remember(this.graphics, key, graphics, GRAPHICS_CACHE_MAX);
      }
      return detectFields(layer.pages, frames, { graphics, types: SENDER_TYPES });
    } catch (e) {
      this.log.warn(`field suggestions unavailable for document ${document_id} (${e instanceof Error ? e.name : 'error'})`);
      return empty;
    }
  }
}
