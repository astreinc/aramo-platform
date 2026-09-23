import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import {
  type DocumentRenderingPort,
  type PrepareFromSourceOptions,
  type PreparedField,
  type RenderModel,
  type RenderProvenance,
  type RenderedOutput,
} from './document-rendering.port.js';
import { RenderFailedError } from './errors.js';

// DOC-2 boundary 5 — the pdf-lib implementation of DocumentRenderingPort. pdf-lib
// is the initial engine and is confined to THIS file. Determinism is DESIGNED:
// all nondeterministic PDF metadata (producer/creator/creation+mod dates) is
// pinned to constants and object streams are disabled, so identical inputs yield
// byte-identical output. The provenance manifest is the authoritative
// reproducibility proof (R-2-4). No LLM, no network, no filesystem access.

const RENDERER_VERSION = '1.17.1'; // pdf-lib version pinned in package.json
// Fixed epoch for PDF metadata dates — normalizes an otherwise nondeterministic
// field so the output hash is stable across renders of the same input.
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');
const PRODUCER = 'Aramo Documents (pdf-lib)';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

@Injectable()
export class PdfLibDocumentRenderingAdapter implements DocumentRenderingPort {
  private pinMetadata(doc: PDFDocument): void {
    doc.setProducer(PRODUCER);
    doc.setCreator(PRODUCER);
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
  }

  private async save(doc: PDFDocument): Promise<Uint8Array> {
    // useObjectStreams: false → stable, deterministic serialization.
    return doc.save({ useObjectStreams: false });
  }

  async renderGenerated(model: RenderModel): Promise<RenderedOutput> {
    try {
      const doc = await PDFDocument.create();
      this.pinMetadata(doc);
      doc.setTitle(model.title);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);

      let page = doc.addPage([612, 792]); // US Letter
      let cursorY = 740;
      const marginX = 54;
      const drawLine = (text: string, size: number, useBold: boolean) => {
        if (cursorY < 54) {
          page = doc.addPage([612, 792]);
          cursorY = 740;
        }
        page.drawText(text, { x: marginX, y: cursorY, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
        cursorY -= size + 8;
      };

      drawLine(model.title, 18, true);
      cursorY -= 8;
      for (const block of model.blocks) {
        drawLine(block.text, block.type === 'HEADING' ? 14 : 11, block.type === 'HEADING');
      }

      const bytes = await this.save(doc);
      const output_sha256 = sha256Hex(bytes);
      const provenance: RenderProvenance = {
        renderer: 'PDF_LIB',
        renderer_version: RENDERER_VERSION,
        template_version_id: model.template_version_id,
        render_manifest_sha256: manifestSha256(model),
        output_sha256,
      };
      return { bytes, sha256: output_sha256, page_count: doc.getPageCount(), provenance };
    } catch (e) {
      if (e instanceof RenderFailedError) throw e;
      throw new RenderFailedError(e instanceof Error ? e.message : String(e));
    }
  }

  async prepareFromSource(
    sourcePdf: Uint8Array,
    placements: PreparedField[],
    opts?: PrepareFromSourceOptions,
  ): Promise<RenderedOutput> {
    const source_artifact_sha256 = sha256Hex(sourcePdf);
    try {
      // NEVER ignoreEncryption — an encrypted source throws here (defence in
      // depth atop the safe-upload pipeline).
      const doc = await PDFDocument.load(sourcePdf);
      this.pinMetadata(doc);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      for (const p of placements) {
        const page = pages[p.page_number];
        if (page === undefined) throw new RenderFailedError(`placement page ${p.page_number} out of range`);
        const { width, height } = page.getSize();
        if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) {
          throw new RenderFailedError(`placement ${p.field_key} out of page bounds`);
        }
        page.drawText(p.value, { x: p.x, y: p.y, size: p.size ?? 11, font, color: rgb(0, 0, 0) });
      }
      const bytes = await this.save(doc);
      const output_sha256 = sha256Hex(bytes);
      const provenance: RenderProvenance = {
        renderer: 'PDF_LIB',
        renderer_version: RENDERER_VERSION,
        template_version_id: opts?.template_version_id,
        render_manifest_sha256: manifestSha256(placements),
        source_artifact_sha256,
        output_sha256,
      };
      return { bytes, sha256: output_sha256, page_count: doc.getPageCount(), provenance };
    } catch (e) {
      if (e instanceof RenderFailedError) throw e;
      throw new RenderFailedError(e instanceof Error ? e.message : String(e));
    }
  }
}
