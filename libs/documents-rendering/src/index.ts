// @aramo/documents-rendering — the Aramo-owned PDF rendering boundary (DOC-2).
// pdf-lib is the initial engine, confined to PdfLibDocumentRenderingAdapter.
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
} from './lib/document-rendering.port.js';
export { PdfLibDocumentRenderingAdapter } from './lib/pdf-lib-document-rendering.adapter.js';
export { SafePdfPipeline, type SafePdfLimits } from './lib/safe-upload.pipeline.js';
export { RenderFailedError, UnsafePdfError } from './lib/errors.js';
