import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import {
  type DocumentRenderingPort,
  type PrepareFromSourceOptions,
  type PreparedField,
  type RenderModel,
  type RenderProvenance,
  type RenderedOutput,
  type RichBlock,
  type RichRun,
  type SignatureBlockModel,
  type SignatureFieldPlacement,
  type SignatureRoleBlockModel,
} from './document-rendering.port.js';
import { RenderFailedError } from './errors.js';
import { SIGNATURE_SCRIPT_FONT_BASE64 } from './fonts/signature-script.font.js';

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

// ── Per-role signature blocks (Amendment M-A6 §3.3) ─────────────────────────────
// The SAME three columns as the fixed block, under a bold role-label line. The printed
// name column is left empty (a SIGNER_NAME placement Sign fills at signing). Blocks are
// stacked with a gap; each block is kept whole on one page.
const ROLE_LABEL_SIZE = 9;
const ROLE_LABEL_GAP = 6; // role label baseline → top of the signature area
const ROLE_BLOCK_GAP = 10; // between consecutive role blocks
export const ROLE_SIGNATURE_BLOCK_HEIGHT = SIGNATURE_BLOCK_HEIGHT + ROLE_LABEL_SIZE + ROLE_LABEL_GAP;

export interface RoleSignatureBlockLayout {
  new_page: boolean;
  role_key: string;
  label_text: string;
  label_y: number;
  rule_y: number;
  column_label_y: number;
  columns: ReadonlyArray<{ x: number; width: number; label: string }>;
  fields: ReadonlyArray<Omit<SignatureFieldPlacement, 'page_number'>>;
  next_y: number;
}

export function layoutRoleSignatureBlock(
  cursorY: number,
  block: SignatureRoleBlockModel,
  measureLabel: (s: string) => number,
): RoleSignatureBlockLayout {
  const newPage = cursorY - ROLE_SIGNATURE_BLOCK_HEIGHT < BOTTOM_MARGIN;
  const top = newPage ? TOP_Y : cursorY;
  const colWidth = (CONTENT_WIDTH - 2 * SIG_COLUMN_GAP) / 3;
  const colX = [0, 1, 2].map((i) => MARGIN_X + i * (colWidth + SIG_COLUMN_GAP));
  const labelY = top - SIG_TOP_GAP;
  const ruleY = labelY - ROLE_LABEL_GAP - SIG_AREA_HEIGHT;
  // The role label is one line: an over-long label is cut (deterministically) to the width.
  const lines = wrapTextToWidth(block.label, measureLabel, CONTENT_WIDTH).filter((l) => l.length > 0);
  const label_text = lines[0] ?? block.role_key;
  const x0 = colX[0] as number;
  const x1 = colX[1] as number;
  const x2 = colX[2] as number;
  return {
    new_page: newPage,
    role_key: block.role_key,
    label_text,
    label_y: labelY,
    rule_y: ruleY,
    column_label_y: ruleY - SIG_LABEL_GAP,
    columns: [
      { x: x0, width: colWidth, label: 'SIGNATURE' },
      { x: x1, width: colWidth, label: 'PRINTED NAME' },
      { x: x2, width: colWidth, label: 'DATE SIGNED' },
    ],
    fields: [
      { field_type: 'SIGNATURE', x: x0, y: ruleY + 2, width: colWidth, height: SIG_AREA_HEIGHT - 4, role_key: block.role_key },
      { field_type: 'SIGNER_NAME', x: x1, y: ruleY + 2, width: colWidth, height: SIG_DATE_FIELD_HEIGHT, role_key: block.role_key },
      { field_type: 'SIGN_DATE', x: x2, y: ruleY + 2, width: colWidth, height: SIG_DATE_FIELD_HEIGHT, role_key: block.role_key },
    ],
    next_y: ruleY - SIG_LABEL_GAP - SIG_LABEL_SIZE - ROLE_BLOCK_GAP,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// The manifest projection of a model: identical to the model except letterhead bytes are
// replaced by their sha256 (bytes do not JSON-serialise meaningfully). A model without a
// letterhead is returned unchanged, so v1 manifests hash exactly as before.
export function manifestProjection(model: RenderModel): unknown {
  if (model.letterhead === undefined) return model;
  const { image_format, image_sha256, name } = model.letterhead;
  return { ...model, letterhead: { image_format, image_sha256, name } };
}

// ── Rich (rtr-html-v1) run layout ──────────────────────────────────────────────────
// Greedy line fill over styled words. Each word is measured in its own font; a single
// space separates words (runs of whitespace collapse); '\n' forces a break; a word wider
// than the line is hard-broken via wrapTextToWidth. Pure + deterministic.
interface RunStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}
export interface LaidOutSegment {
  text: string;
  style: RunStyle;
  // leading space before this segment (0 for the first segment on a line)
  space_before: boolean;
  space_underline: boolean;
}
type Measure = (text: string, style: RunStyle) => number;

export function layoutRuns(runs: readonly RichRun[], measure: Measure, maxWidth: number): LaidOutSegment[][] {
  type Tok = { kind: 'word'; text: string; style: RunStyle } | { kind: 'space'; style: RunStyle } | { kind: 'break' };
  const toks: Tok[] = [];
  for (const r of runs) {
    const style: RunStyle = { bold: r.bold === true, italic: r.italic === true, underline: r.underline === true };
    const parts = r.text.replace(/\r\n?/g, '\n').split(/(\n|[ \t]+)/);
    for (const part of parts) {
      if (part === '') continue;
      if (part === '\n') toks.push({ kind: 'break' });
      else if (/^[ \t]+$/.test(part)) toks.push({ kind: 'space', style });
      else toks.push({ kind: 'word', text: part, style });
    }
  }
  const lines: LaidOutSegment[][] = [];
  let line: LaidOutSegment[] = [];
  let width = 0;
  let pendingSpace: RunStyle | null = null;
  const spaceW = (st: RunStyle): number => measure(' ', st);
  const pushLine = (): void => {
    lines.push(line);
    line = [];
    width = 0;
    pendingSpace = null;
  };
  for (const t of toks) {
    if (t.kind === 'break') {
      pushLine();
      continue;
    }
    if (t.kind === 'space') {
      if (line.length > 0) pendingSpace = t.style;
      continue;
    }
    const w = measure(t.text, t.style);
    const sp: RunStyle | null = line.length > 0 ? pendingSpace : null;
    const extra = sp !== null ? spaceW(sp) : 0;
    if (line.length > 0 && width + extra + w > maxWidth) pushLine();
    if (w > maxWidth) {
      const pieces = wrapTextToWidth(t.text, (s) => measure(s, t.style), maxWidth);
      pieces.forEach((piece, i) => {
        if (i > 0) pushLine();
        line.push({ text: piece, style: t.style, space_before: false, space_underline: false });
        width = measure(piece, t.style);
      });
      pendingSpace = null;
      continue;
    }
    const hasSpace = line.length > 0 && sp !== null;
    line.push({ text: t.text, style: t.style, space_before: hasSpace, space_underline: hasSpace && sp !== null && sp.underline && t.style.underline });
    width += (hasSpace ? extra : 0) + w;
    pendingSpace = null;
  }
  if (line.length > 0 || lines.length === 0 || toks[toks.length - 1]?.kind === 'break') lines.push(line);
  return lines;
}

const LIST_INDENT = 18;
const LIST_ITEM_GAP = 2;
const LETTERHEAD_TOP = 762;
const LETTERHEAD_MAX_HEIGHT = 44;
const LETTERHEAD_MAX_WIDTH = 170;
const LETTERHEAD_NAME_SIZE = 13;

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
      // A1 §2.4 — letterhead (rich path only): the frozen logo + organisation name.
      if (model.letterhead !== undefined) {
        const lh = model.letterhead;
        const img = lh.image_format === 'PNG' ? await doc.embedPng(lh.image_bytes) : await doc.embedJpg(lh.image_bytes);
        const scale = Math.min(LETTERHEAD_MAX_HEIGHT / img.height, LETTERHEAD_MAX_WIDTH / img.width, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: MARGIN_X, y: LETTERHEAD_TOP - h, width: w, height: h });
        if (lh.name !== null && lh.name.trim().length > 0) {
          const nameX = MARGIN_X + w + 12;
          const nameLines = wrapTextToWidth(lh.name.trim(), (s) => bold.widthOfTextAtSize(s, LETTERHEAD_NAME_SIZE), PAGE_WIDTH - MARGIN_X - nameX).slice(0, 2);
          const blockH = nameLines.length * LETTERHEAD_NAME_SIZE * LINE_HEIGHT_FACTOR;
          let ny = LETTERHEAD_TOP - h / 2 + blockH / 2 - LETTERHEAD_NAME_SIZE;
          for (const l of nameLines) {
            page.drawText(l, { x: nameX, y: ny, size: LETTERHEAD_NAME_SIZE, font: bold, color: rgb(0, 0, 0) });
            ny -= LETTERHEAD_NAME_SIZE * LINE_HEIGHT_FACTOR;
          }
        }
        cursorY = Math.min(TOP_Y, LETTERHEAD_TOP - h - 24);
      }
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
      if (model.rich_blocks !== undefined) {
        // A1 §2.3 — rich content. Oblique faces are embedded ONLY on this path so the
        // rtr-generated-v1 output stays byte-identical.
        const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
        const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
        const fontFor = (st: RunStyle): PDFFont => (st.bold ? (st.italic ? boldItalic : bold) : st.italic ? italic : font);
        const ensureRoom = (size: number): void => {
          if (cursorY - size < BOTTOM_MARGIN) {
            page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            cursorY = TOP_Y;
          }
        };
        const drawRuns = (runs: readonly RichRun[], size: number, x0: number, width: number, marker?: { text: string; x: number }) => {
          const measure: Measure = (t, st) => fontFor(st).widthOfTextAtSize(t, size);
          const lines = layoutRuns(runs, measure, width);
          const lineHeight = size * LINE_HEIGHT_FACTOR;
          lines.forEach((segs, li) => {
            ensureRoom(size);
            if (li === 0 && marker !== undefined) {
              page.drawText(marker.text, { x: marker.x, y: cursorY, size, font, color: rgb(0, 0, 0) });
            }
            let x = x0;
            for (const seg of segs) {
              const f = fontFor(seg.style);
              if (seg.space_before) {
                const sw = f.widthOfTextAtSize(' ', size);
                if (seg.space_underline) {
                  page.drawLine({ start: { x, y: cursorY - 1.5 }, end: { x: x + sw, y: cursorY - 1.5 }, thickness: 0.6, color: rgb(0, 0, 0) });
                }
                x += sw;
              }
              const w = f.widthOfTextAtSize(seg.text, size);
              page.drawText(seg.text, { x, y: cursorY, size, font: f, color: rgb(0, 0, 0) });
              if (seg.style.underline) {
                page.drawLine({ start: { x, y: cursorY - 1.5 }, end: { x: x + w, y: cursorY - 1.5 }, thickness: 0.6, color: rgb(0, 0, 0) });
              }
              x += w;
            }
            cursorY -= lineHeight;
          });
        };
        const drawBlocks = (blocks: readonly RichBlock[], level: number): void => {
          for (const b of blocks) {
            if (b.kind === 'heading') {
              drawRuns(b.runs.map((r) => ({ ...r, bold: true })), HEADING_SIZE, MARGIN_X, CONTENT_WIDTH);
              cursorY -= BLOCK_GAP;
            } else if (b.kind === 'paragraph') {
              drawRuns(b.runs, BODY_SIZE, MARGIN_X, CONTENT_WIDTH);
              cursorY -= BLOCK_GAP;
            } else {
              const markerX = MARGIN_X + level * LIST_INDENT;
              const textX = markerX + LIST_INDENT;
              b.items.forEach((item, i) => {
                const marker = b.ordered ? `${i + 1}.` : '\u2022';
                drawRuns(item.runs, BODY_SIZE, textX, PAGE_WIDTH - MARGIN_X - textX, { text: marker, x: markerX });
                if (item.children.length > 0) drawBlocks(item.children, level + 1);
                cursorY -= LIST_ITEM_GAP;
              });
              if (level === 0) cursorY -= BLOCK_GAP;
            }
          }
        };
        drawBlocks(model.rich_blocks, 0);
      } else {
        for (const block of model.blocks) {
          const isHeading = block.type === 'HEADING';
          drawWrapped(block.text, isHeading ? HEADING_SIZE : BODY_SIZE, isHeading);
        }
      }

      let signature_fields: SignatureFieldPlacement[] | undefined;
      if (model.signature_blocks !== undefined && model.signature_blocks.length > 0) {
        // M-A6 §3.3 — one block per SIGNER role (replaces the single fixed block).
        signature_fields = [];
        for (const role of model.signature_blocks) {
          const appended = this.appendRoleSignatureBlock(doc, page, cursorY, role, bold);
          page = appended.page;
          cursorY = appended.cursorY;
          signature_fields.push(...appended.fields);
        }
      } else if (model.signature_block !== undefined) {
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
        render_manifest_sha256: manifestSha256(manifestProjection(model)),
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

  // M-A6 §3.3 — append one SIGNER role's block at the cursor (new page when it does not
  // fit; never split). Placements carry the role_key.
  appendRoleSignatureBlock(
    doc: PDFDocument,
    page: PDFPage,
    cursorY: number,
    block: SignatureRoleBlockModel,
    bold: PDFFont,
  ): { page: PDFPage; cursorY: number; fields: SignatureFieldPlacement[] } {
    const layout = layoutRoleSignatureBlock(cursorY, block, (s) => bold.widthOfTextAtSize(s, ROLE_LABEL_SIZE));
    let target = page;
    if (layout.new_page) target = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageIndex = doc.getPages().indexOf(target);
    const ink = rgb(0, 0, 0);
    const muted = rgb(0.35, 0.35, 0.35);
    target.drawText(layout.label_text, { x: MARGIN_X, y: layout.label_y, size: ROLE_LABEL_SIZE, font: bold, color: ink });
    for (const col of layout.columns) {
      target.drawLine({ start: { x: col.x, y: layout.rule_y }, end: { x: col.x + col.width, y: layout.rule_y }, thickness: 0.75, color: ink });
      target.drawText(col.label, { x: col.x, y: layout.column_label_y, size: SIG_LABEL_SIZE, font: bold, color: muted });
    }
    return { page: target, cursorY: layout.next_y, fields: layout.fields.map((f) => ({ ...f, page_number: pageIndex })) };
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
      // PX-2 — the handwriting font is embedded only when a placement asks for it,
      // so documents without typed signatures are byte-identical to before.
      let script: PDFFont | null = null;
      const bold = placements.some((p) => p.stamp !== undefined) ? await doc.embedFont(StandardFonts.HelveticaBold) : font;
      if (placements.some((p) => p.font === 'SCRIPT')) {
        doc.registerFontkit(fontkit);
        script = await doc.embedFont(Buffer.from(SIGNATURE_SCRIPT_FONT_BASE64, 'base64'), { subset: true });
      }
      const pages = doc.getPages();
      for (const p of placements) {
        const page = pages[p.page_number];
        if (page === undefined) throw new RenderFailedError(`placement page ${p.page_number} out of range`);
        const { width, height } = page.getSize();
        if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) {
          throw new RenderFailedError(`placement ${p.field_key} out of page bounds`);
        }
        if (p.kind === 'MARK') {
          if (p.checked === undefined) throw new RenderFailedError(`mark placement ${p.field_key} missing checked`);
          drawMark(page, p, p.checked);
        } else if (p.kind === 'IMAGE') {
          // DOC-4 B1 — DRAWN/UPLOADED signature image. Embed is deterministic
          // (identical bytes → identical embedded object), preserving hash-stability.
          if (p.image_bytes === undefined || p.image_format === undefined) {
            throw new RenderFailedError(`image placement ${p.field_key} missing image_bytes/image_format`);
          }
          const img =
            p.image_format === 'PNG'
              ? await doc.embedPng(p.image_bytes)
              : await doc.embedJpg(p.image_bytes);
          if (p.stamp !== undefined) {
            const box = stampBox(p);
            drawStamp(page, box, p.stamp, font, bold);
            const inner = { x: box.x + 8, y: box.y + 6, w: box.w - 10, h: box.h - 10 };
            const k = Math.min(inner.w / img.width, inner.h / img.height);
            page.drawImage(img, { x: inner.x, y: inner.y + (inner.h - img.height * k) / 2, width: img.width * k, height: img.height * k });
          } else {
            page.drawImage(img, { x: p.x, y: p.y, width: p.width ?? img.width, height: p.height ?? img.height });
          }
        } else {
          if (p.value === undefined) {
            throw new RenderFailedError(`text placement ${p.field_key} missing value`);
          }
          if (p.font === 'SCRIPT' && script !== null) {
            const box = stampBox(p);
            if (p.stamp !== undefined) drawStamp(page, box, p.stamp, font, bold);
            const inner = p.stamp !== undefined ? { x: box.x + 8, y: box.y + 6, w: box.w - 10, h: box.h - 10 } : { x: box.x, y: box.y, w: box.w, h: box.h };
            const size = Math.max(6, Math.min(inner.h * 0.62, (inner.w / Math.max(1, script.widthOfTextAtSize(p.value, 1))) * 0.98));
            page.drawText(p.value, { x: inner.x, y: inner.y + (inner.h - size) / 2 + size * 0.22, size, font: script, color: rgb(0.08, 0.12, 0.32) });
          } else {
            page.drawText(p.value, { x: p.x, y: p.y, size: p.size ?? 11, font, color: rgb(0, 0, 0) });
          }
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
          font: p.font,
          stamp: p.stamp,
          checked: p.checked,
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

// PX-2 — the field box of a signature placement (PDF points, bottom-left origin).
function stampBox(p: PreparedField): { x: number; y: number; w: number; h: number } {
  return { x: p.x, y: p.y, w: p.width ?? 220, h: p.height ?? 48 };
}

// M-A6 §1 — a vector check box: a square border, plus a vector check stroke when
// checked. Pure vector drawing (no font, no glyph), so a checkbox value is never
// printed as text on the executed PDF. The square sits at the field box's
// lower-left corner, sized to the box's shorter side.
function drawMark(page: PDFPage, p: PreparedField, checked: boolean): void {
  const side = Math.max(6, Math.min(p.width ?? 12, p.height ?? 12));
  const ink = rgb(0, 0, 0);
  page.drawRectangle({ x: p.x, y: p.y, width: side, height: side, borderColor: ink, borderWidth: Math.max(0.6, side * 0.07) });
  if (!checked) return;
  // SVG path in a y-down frame anchored at the square's top-left corner.
  const path = `M ${side * 0.2} ${side * 0.52} L ${side * 0.42} ${side * 0.74} L ${side * 0.8} ${side * 0.24}`;
  page.drawSvgPath(path, { x: p.x, y: p.y + side, borderColor: ink, borderWidth: Math.max(1, side * 0.12) });
}

// PX-2 — DocuSign-style signature frame: a rounded left bracket whose top and
// bottom arms carry the "Signed by:" label (bold) and the Signature ID — the
// signer's ledger entry hash, also printed in the execution certificate.
function drawStamp(page: PDFPage, box: { x: number; y: number; w: number; h: number }, stamp: { label: string; id: string }, font: PDFFont, bold: PDFFont): void {
  const blue = rgb(0.23, 0.29, 0.86);
  const r = Math.min(6, box.h / 4);
  const arm = Math.min(box.w * 0.42, 86);
  const topY = box.y + box.h - 2; // PDF y of the top arm
  const botY = box.y + 4; // PDF y of the bottom arm
  const h = topY - botY;
  // SVG path in a y-down frame anchored at the top-left (box.x, topY).
  const path = `M ${arm} 0 L ${r} 0 Q 0 0 0 ${r} L 0 ${h - r} Q 0 ${h} ${r} ${h} L ${arm} ${h}`;
  page.drawSvgPath(path, { x: box.x, y: topY, borderColor: blue, borderWidth: 1.1 });
  page.drawText(stamp.label, { x: box.x + r + 1.5, y: topY + 1.8, size: 5.8, font: bold, color: rgb(0.12, 0.12, 0.16) });
  if (stamp.id.length > 0) page.drawText(stamp.id, { x: box.x + r + 1.5, y: botY - 6.3, size: 5.2, font, color: rgb(0.3, 0.3, 0.36) });
}
