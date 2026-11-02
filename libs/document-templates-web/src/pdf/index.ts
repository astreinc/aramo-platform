// @aramo/document-templates-web/pdf — the PDF page geometry and rendering helpers
// (TEMPLATE-PRODUCT-1 Implementation Directive v1.0 LOCKED §7.2), extracted from
// apps/sign-web/src/workspace/{geometry,pdf}.ts. A SUBPATH entry, separate from the
// package root, so Aramo Sign's prepare editor imports only these helpers (pdfjs-dist stays
// lazily loaded) and never the Studio code or its stylesheets. Consumers: apps/sign-web
// (prepare editor) and this lib's fixed-form Studio mode.
export { clampBox, toPdf, toTopLeft, type Box, type PdfPageInfo } from './geometry';
export { loadPdf, type LoadedPdf } from './pdf';
