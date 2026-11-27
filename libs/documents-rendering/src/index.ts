// @aramo/documents-rendering — the Aramo-owned PDF rendering boundary (DOC-2).
// pdf-lib is the initial engine, confined to PdfLibDocumentRenderingAdapter (plus the safe-upload
// pipeline and, for FIELD-PARITY-1 P2-5 / P2-6, pdf-form-import.ts and text-layer.ts).
// Consumers depend ONLY on DocumentRenderingPort.
export {
  DOCUMENT_RENDERING_PORT,
  type DocumentRenderingPort,
  type RenderModel,
  type RenderBlock,
  type PreparedField,
  type RenderedOutput,
  type RenderProvenance,
  type PrepareFromSourceOptions,
  type SignatureBlockModel,
  type RichBlock,
  type RichRun,
  type RichTextRun,
  type RichFieldRun,
  type InlineFieldPlacement,
  isFieldRun,
  type RichListItem,
  type LetterheadModel,
  type SignatureFieldPlacement,
  type SignatureRoleBlockModel,
} from './lib/document-rendering.port.js';
export {
  PdfLibDocumentRenderingAdapter,
  layoutRuns,
  inlineFieldMaxWidth,
  type InlineFieldPlace,
  layoutRoleSignatureBlock,
  layoutSignatureBlock,
  manifestProjection,
  wrapTextToWidth,
  layoutTextInBox,
  sanitizeWinAnsi,
  stampTextInBox,
  stampTextUnbounded,
  TEXT_BOX_MAX_SIZE,
  TEXT_BOX_MIN_SIZE,
  type TextBox,
  type TextBoxLayout,
  type TextBoxLine,
} from './lib/pdf-lib-document-rendering.adapter.js';
export { SafePdfPipeline, type SafePdfLimits } from './lib/safe-upload.pipeline.js';
// PDF-ATTACH-1 — the one rule for attached files (remove at upload; the gate refuses what remains).
export { removePdfAttachments, findPdfAttachment, type PdfAttachmentRemoval } from './lib/pdf-attachments.js';
export { RenderFailedError, InlineFieldTooWideError, UnsafePdfError, type PdfProblem } from './lib/errors.js';
// FIELD-PARITY-1 P2-5 / P2-6 — fillable-PDF import (read, strip active content, flatten),
// covering text tags, and the text layer / page frames (moved from apps/sign-service).
export {
  importPdfForm,
  coverPdfBoxes,
  PdfFormImportError,
  type PdfFormImport,
  type PdfFormKind,
  type PdfFormWidgetRead,
  type PdfCoverBox,
} from './lib/pdf-form-import.js';
// FIELD-PARITY-2 A-6 (ruling C-8) — a text tag's text is removed from the page, then covered.
export { removeAndCoverTextTags, type PdfTextTagBox, type PdfTextTagRemoval } from './lib/pdf-tag-text.js';
export {
  extractTextLayer,
  wordsOfRun,
  readPageFrames,
  extractPageGraphics,
  PAGE_GRAPHICS_MAX_RECTS,
  PAGE_GRAPHICS_MAX_OPS,
  TEXT_LAYER_MAX_PAGES,
  TEXT_LAYER_MAX_WORDS,
  type TextLayerWord,
  type TextLayerPage,
  type PdfPageFrame,
  type PageGraphicRect,
  type PageGraphics,
} from './lib/text-layer.js';
