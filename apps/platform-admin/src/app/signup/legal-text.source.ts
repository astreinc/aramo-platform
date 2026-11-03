import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { LegalDocumentVersion } from '@aramo/subscription';

// Aramo-Sign-Mobile-Amendment-M-A11 (LOCKED) §2.2 — the exact bytes of an approved
// legal document, for the native terms screen. The texts are the repo files the
// registry pins (LegalDocumentVersion.path, e.g. doc/legal/aramo/privacy-notice.md),
// resolved from the process working directory: the repository root in development
// and tests, /app in the image (apps/platform-admin/Dockerfile copies doc/legal
// there). A text is served only when its bytes hash to the registry's sha256; a
// missing or changed file is never served (logged by reason code only).

export const LEGAL_TEXT_ROOT = 'LEGAL_TEXT_ROOT';

@Injectable()
export class LegalTextSource {
  private readonly log = new Logger(LegalTextSource.name);
  private readonly cache = new Map<string, string>();
  private readonly root: string;

  constructor(@Optional() @Inject(LEGAL_TEXT_ROOT) root?: string) {
    this.root = root ?? process.cwd();
  }

  /** The UTF-8 text whose bytes hash to `doc.sha256`, or null. */
  text(doc: Pick<LegalDocumentVersion, 'key' | 'version' | 'path' | 'sha256'>): string | null {
    const id = `${doc.path}#${doc.sha256}`;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const file = resolve(this.root, doc.path);
    const rel = relative(this.root, file);
    if (rel.startsWith('..') || isAbsolute(rel) || !rel.startsWith('doc/legal/')) {
      this.log.error(`legal text refused: path_outside_legal (${doc.key}@${doc.version})`);
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      this.log.error(`legal text unavailable: file_missing (${doc.key}@${doc.version})`);
      return null;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
      this.log.error(`legal text unavailable: sha256_mismatch (${doc.key}@${doc.version})`);
      return null;
    }
    const text = bytes.toString('utf8');
    // The served string must encode back to the very same bytes (no BOM / invalid UTF-8 loss).
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      this.log.error(`legal text unavailable: not_utf8 (${doc.key}@${doc.version})`);
      return null;
    }
    this.cache.set(id, text);
    return text;
  }
}
