import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import {
  type DocumentRenderingPort,
  type PrepareFromSourceOptions,
  type PreparedField,
  type RenderModel,
  type RenderProvenance,
  type RenderedOutput,
  type SignatureBlockModel,
  type SignatureFieldPlacement,
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

// GENERATED-path page geometry (US Letter, points).
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const TOP_Y = 740;
const BOTTOM_MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
const TITLE_SIZE = 18;
const HEADING_SIZE = 14;
const BODY_SIZE = 11;
const LINE_HEIGHT_FACTOR = 1.4;
const BLOCK_GAP = 6;

// Greedy word-wrap of `text` to `maxWidth` using the supplied width measure (the
// embedded font's widthOfTextAtSize). Explicit newlines start a new line (an empty
// source line is kept as a blank line); runs of spaces collapse to one; a single
// word wider than the line is broken by character so nothing overflows the margin.
// Pure + deterministic (same input → same lines), so render hash-stability holds.
export function wrapTextToWidth(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = rawLine.split(/[ \t]+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const trial = current.length === 0 ? word : `${current} ${word}`;
      if (measure(trial) <= maxWidth) {
        current = trial;
        continue;
      }
      if (current.length > 0) out.push(current);
      if (measure(word) <= maxWidth) {
        current = word;
        continue;
      }
      // Hard-break an over-long word.
      let chunk = '';
      for (const ch of word) {
        if (chunk.length > 0 && measure(chunk + ch) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    }
    out.push(current);
  }
  return out;
}

// ── Fixed signature block (B2, spec §9.3 / Amendment A1 §2.3) ──────────────────
// Three equal columns across the content width: TALENT SIGNATURE (signature area) ·
// PRINTED NAME (the bound talent name, wrapped to the column) · DATE SIGNED (blank;
// stamped at signing). Geometry is computed by the PURE layoutSignatureBlock so any
// GENERATED renderer (rtr-generated-v1 today, rtr-html-v1 next) appends the identical
// block via PdfLibDocumentRenderingAdapter.appendSignatureBlock.
const SIG_COLUMN_GAP = 18;
const SIG_TOP_GAP = 28; // space between the content and the block
const SIG_AREA_HEIGHT = 40; // writable area above each rule
const SIG_LABEL_SIZE = 8;
const SIG_NAME_SIZE = 10;
const SIG_LABEL_GAP = 11; // rule → label baseline
const SIG_DATE_FIELD_HEIGHT = 16;
export const SIGNATURE_BLOCK_HEIGHT = SIG_TOP_GAP + SIG_AREA_HEIGHT + SIG_LABEL_GAP + SIG_LABEL_SIZE;

export interface SignatureBlockLayout {
  // true when the block does not fit above the bottom margin and must start a new page
  // (the block is never split across pages).
  new_page: boolean;
  rule_y: number;
  label_y: number;
  columns: ReadonlyArray<{ x: number; width: number; label: string }>;
  printed_name_lines: ReadonlyArray<{ text: string; y: number }>;
  fields: ReadonlyArray<Omit<SignatureFieldPlacement, 'page_number'>>;
  // cursor after the block (same page as the block).
  next_y: number;
}

export function layoutSignatureBlock(
  cursorY: number,
  printedName: string,
  measureName: (s: string) => number,
): SignatureBlockLayout {
  const newPage = cursorY - SIGNATURE_BLOCK_HEIGHT < BOTTOM_MARGIN;
  const top = newPage ? TOP_Y : cursorY;
  const colWidth = (CONTENT_WIDTH - 2 * SIG_COLUMN_GAP) / 3;
  const colX = [0, 1, 2].map((i) => MARGIN_X + i * (colWidth + SIG_COLUMN_GAP));
  const ruleY = top - SIG_TOP_GAP - SIG_AREA_HEIGHT;
  // Printed name: wrapped to the column, bottom line sits just above the rule; at most
  // as many lines as fit in the area (extra lines are dropped from the TOP — never drawn
  // over the label). Deterministic.
  const lineHeight = SIG_NAME_SIZE * LINE_HEIGHT_FACTOR;
  const maxLines = Math.max(1, Math.floor((SIG_AREA_HEIGHT - 4) / lineHeight));
  const wrapped = wrapTextToWidth(printedName, measureName, colWidth).filter((l) => l.length > 0);
  const kept = wrapped.slice(Math.max(0, wrapped.length - maxLines));
  const printed = kept.map((text, i) => ({ text, y: ruleY + 4 + (kept.length - 1 - i) * lineHeight }));
  const x0 = colX[0] as number;
  const x1 = colX[1] as number;
  const x2 = colX[2] as number;
  return {
    new_page: newPage,
    rule_y: ruleY,
    label_y: ruleY - SIG_LABEL_GAP,
    columns: [
      { x: x0, width: colWidth, label: 'TALENT SIGNATURE' },
      { x: x1, width: colWidth, label: 'PRINTED NAME' },
      { x: x2, width: colWidth, label: 'DATE SIGNED' },
    ],
    printed_name_lines: printed,
    fields: [
      { field_type: 'SIGNATURE', x: x0, y: ruleY + 2, width: colWidth, height: SIG_AREA_HEIGHT - 4 },
      { field_type: 'SIGNER_NAME', x: x1, y: ruleY + 2, width: colWidth, height: SIG_AREA_HEIGHT - 4 },
      { field_type: 'SIGN_DATE', x: x2, y: ruleY + 2, width: colWidth, height: SIG_DATE_FIELD_HEIGHT },
    ],
    next_y: ruleY - SIG_LABEL_GAP - SIG_LABEL_SIZE,
  };
}

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

      let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); // US Letter
      let cursorY = TOP_Y;
      // Word-wrap each block to the content width; a line that would cross the bottom
      // margin starts a new page. Long paragraphs therefore flow instead of running off
      // the page edge.
      const drawWrapped = (text: string, size: number, useBold: boolean) => {
        const f = useBold ? bold : font;
        const lines = wrapTextToWidth(text, (s) => f.widthOfTextAtSize(s, size), CONTENT_WIDTH);
        const lineHeight = size * LINE_HEIGHT_FACTOR;
        for (const line of lines) {
          if (cursorY - size < BOTTOM_MARGIN) {
            page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            cursorY = TOP_Y;
          }
          if (line.length > 0) {
            page.drawText(line, { x: MARGIN_X, y: cursorY, size, font: f, color: rgb(0, 0, 0) });
          }
          cursorY -= lineHeight;
        }
        cursorY -= BLOCK_GAP;
      };

      drawWrapped(model.title, TITLE_SIZE, true);
      cursorY -= BLOCK_GAP;
      for (const block of model.blocks) {
        const isHeading = block.type === 'HEADING';
        drawWrapped(block.text, isHeading ? HEADING_SIZE : BODY_SIZE, isHeading);
      }

      let signature_fields: SignatureFieldPlacement[] | undefined;
      if (model.signature_block !== undefined) {
        const appended = this.appendSignatureBlock(doc, page, cursorY, model.signature_block, font, bold);
        page = appended.page;
        cursorY = appended.cursorY;
        signature_fields = appended.fields;
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
      return {
        bytes,
        sha256: output_sha256,
        page_count: doc.getPageCount(),
        provenance,
        ...(signature_fields !== undefined ? { signature_fields } : {}),
      };
    } catch (e) {
      if (e instanceof RenderFailedError) throw e;
      throw new RenderFailedError(e instanceof Error ? e.message : String(e));
    }
  }

  // B2 / A1 §2.3 — append the fixed signature block at the cursor (new page when it does
  // not fit; never split). Shared by every GENERATED content renderer. Returns the page +
  // cursor after the block and the field placements (0-based page index).
  appendSignatureBlock(
    doc: PDFDocument,
    page: PDFPage,
    cursorY: number,
    block: SignatureBlockModel,
    font: PDFFont,
    bold: PDFFont,
  ): { page: PDFPage; cursorY: number; fields: SignatureFieldPlacement[] } {
    const layout = layoutSignatureBlock(cursorY, block.printed_name, (s) => font.widthOfTextAtSize(s, SIG_NAME_SIZE));
    let target = page;
    if (layout.new_page) target = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageIndex = doc.getPages().indexOf(target);
    const ink = rgb(0, 0, 0);
    const muted = rgb(0.35, 0.35, 0.35);
    for (const col of layout.columns) {
      target.drawLine({
        start: { x: col.x, y: layout.rule_y },
        end: { x: col.x + col.width, y: layout.rule_y },
        thickness: 0.75,
        color: ink,
      });
      target.drawText(col.label, { x: col.x, y: layout.label_y, size: SIG_LABEL_SIZE, font: bold, color: muted });
    }
    const nameCol = layout.columns[1];
    if (nameCol !== undefined) {
      for (const line of layout.printed_name_lines) {
        target.drawText(line.text, { x: nameCol.x, y: line.y, size: SIG_NAME_SIZE, font, color: ink });
      }
    }
    return {
      page: target,
      cursorY: layout.next_y,
      fields: layout.fields.map((f) => ({ ...f, page_number: pageIndex })),
    };
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
        if (p.kind === 'IMAGE') {
          // DOC-4 B1 — DRAWN/UPLOADED signature image. Embed is deterministic
          // (identical bytes → identical embedded object), preserving hash-stability.
          if (p.image_bytes === undefined || p.image_format === undefined) {
            throw new RenderFailedError(`image placement ${p.field_key} missing image_bytes/image_format`);
          }
          const img =
            p.image_format === 'PNG'
              ? await doc.embedPng(p.image_bytes)
              : await doc.embedJpg(p.image_bytes);
          page.drawImage(img, { x: p.x, y: p.y, width: p.width ?? img.width, height: p.height ?? img.height });
        } else {
          if (p.value === undefined) {
            throw new RenderFailedError(`text placement ${p.field_key} missing value`);
          }
          page.drawText(p.value, { x: p.x, y: p.y, size: p.size ?? 11, font, color: rgb(0, 0, 0) });
        }
      }
      const bytes = await this.save(doc);
      const output_sha256 = sha256Hex(bytes);
      const provenance: RenderProvenance = {
        renderer: 'PDF_LIB',
        renderer_version: RENDERER_VERSION,
        template_version_id: opts?.template_version_id,
        // Uint8Array does not JSON-serialize; project image bytes to a sha256 so
        // the manifest hash stays stable + collision-resistant for IMAGE placements.
        render_manifest_sha256: manifestSha256(placements.map((p) => ({
          field_key: p.field_key,
          page_number: p.page_number,
          x: p.x,
          y: p.y,
          kind: p.kind ?? 'TEXT',
          value: p.value,
          size: p.size,
          width: p.width,
          height: p.height,
          image_format: p.image_format,
          image_sha256: p.image_bytes ? sha256Hex(p.image_bytes) : undefined,
        }))),
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
