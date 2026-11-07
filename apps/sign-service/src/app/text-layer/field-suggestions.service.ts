import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

import { DocumentTextLayerService } from './document-text-layer.service.js';
import { type FieldSuggestion, type PageFrame, suggestFields } from './field-suggestions.js';

// Aramo Sign Mobile M-A14 R-3 / §2 — GET .../documents/{documentId}/field-suggestions.
// Reuses the M-A12 text layer (same cache, per document version) and reads each page's
// geometry with pdf-lib (already used for page sizes), cached per version as well. No model
// and no outbound call: the document never leaves the platform. Every failure after the
// caller's visibility check is an empty list (the feature is a convenience), and only the
// document id and the error class are logged — never any text.

const FRAME_CACHE_MAX = 64;

export async function readPageFrames(bytes: Uint8Array): Promise<PageFrame[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((p) => {
    const crop = p.getCropBox();
    return { width: p.getWidth(), height: p.getHeight(), view: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, rotation: p.getRotation().angle };
  });
}

@Injectable()
export class FieldSuggestionsService {
  private readonly log = new Logger(FieldSuggestionsService.name);
  private readonly frames = new Map<string, PageFrame[]>();
  // Replaceable in tests. No constructor parameters beyond the text layer.
  readFrames: (bytes: Uint8Array) => Promise<PageFrame[]> = readPageFrames;

  constructor(private readonly textLayer: DocumentTextLayerService) {}

  async suggest(document_id: string, version: string, load: () => Promise<Uint8Array>): Promise<{ suggestions: FieldSuggestion[] }> {
    try {
      // One byte fetch at most per call, shared by the text layer and the frame read.
      let bytes: Promise<Uint8Array> | undefined;
      const once = (): Promise<Uint8Array> => (bytes ??= load());
      const layer = await this.textLayer.forDocument(document_id, version, once);
      if (!layer.pages.some((p) => p.words.length > 0)) return { suggestions: [] };
      const key = `${document_id}:${version}`;
      let frames = this.frames.get(key);
      if (frames === undefined) {
        frames = await this.readFrames(await once());
        this.frames.set(key, frames);
        while (this.frames.size > FRAME_CACHE_MAX) {
          const oldest = this.frames.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.frames.delete(oldest);
        }
      }
      return { suggestions: suggestFields(layer.pages, frames) };
    } catch (e) {
      this.log.warn(`field suggestions unavailable for document ${document_id} (${e instanceof Error ? e.name : 'error'})`);
      return { suggestions: [] };
    }
  }
}
