// FIELD-PARITY-1 P1-5 — the editor geometry moved into the ONE shared placement editor
// (@aramo/field-placement-web); this subpath re-exports it unchanged so its consumers keep
// one implementation.
export { clampBox, toPdf, toTopLeft, type Box, type PdfPageInfo } from '@aramo/field-placement-web';
