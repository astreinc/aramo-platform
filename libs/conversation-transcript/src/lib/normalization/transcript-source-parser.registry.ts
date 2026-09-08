// CI-B4 — source-parser registry (mirrors the B3 provider-registry PATTERN).
// Keyed by parser.formatKey(). A composition-root/CI-B5 seam registers concrete
// provider format parsers; B4 registers only the generic fixture parser.

import { Injectable } from '@nestjs/common';

import type { TranscriptSourceParser } from './transcript-source-parser.port.js';

@Injectable()
export class TranscriptSourceParserRegistry {
  private readonly byFormat = new Map<string, TranscriptSourceParser>();

  register(parser: TranscriptSourceParser): void {
    this.byFormat.set(parser.formatKey(), parser);
  }

  get(formatKey: string): TranscriptSourceParser | undefined {
    return this.byFormat.get(formatKey);
  }

  has(formatKey: string): boolean {
    return this.byFormat.has(formatKey);
  }
}
