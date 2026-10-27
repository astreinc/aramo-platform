// DOC-2 boundary 5 — the Aramo-owned rendering boundary. Documents/consumers
// depend ONLY on this port; no code outside the adapter imports pdf-lib. The
// port surface is INTENT-LEVEL — renderGenerated / prepareFromSource. inspect /
// fillFields / flatten are adapter-internal (kept off the port so a future
// HTML/specialist adapter can implement the same contract).

export const DOCUMENT_RENDERING_PORT = Symbol('DOCUMENT_RENDERING_PORT');

// A deterministic content block for the GENERATED path. Business-value
// resolution (Job 1) happens BEFORE this in the Documents domain; the renderer
// (Job 2) receives already-resolved text and never queries any ATS database.
export interface RenderBlock {
  type: 'HEADING' | 'TEXT';
  text: string;
}

// The render model handed to the engine. It carries no Aramo business semantics
// beyond resolved values — only what is needed to produce deterministic bytes.
export interface RenderModel {
  template_version_id?: string;
  render_schema_version: string;
  title: string;
  blocks: RenderBlock[];
  // Document Templates slice 1 (B2, spec §9.3 / Amendment A1 §2.3) — when present, the
  // renderer APPENDS the fixed signature block after the content: TALENT SIGNATURE ·
  // PRINTED NAME · DATE SIGNED. Not template content (admins cannot remove it); the
  // domain supplies the bound printed name. Absent ⇒ no block (offer letter, legacy).
  signature_block?: SignatureBlockModel;
  // Amendment M-A6 (LOCKED) §3.3 — multi-role templates: when present the renderer draws
  // ONE block per SIGNER role, in this order (SIGNATURE · PRINTED NAME · DATE SIGNED under
  // the role's label) INSTEAD of `signature_block`. The printed name is NOT drawn: it is a
  // SIGNER_NAME placement Sign fills. Every placement carries the block's role_key. Absent
  // ⇒ the single block above, byte-identical to before.
  signature_blocks?: SignatureRoleBlockModel[];
  // Amendment A1 §2.3 (rtr-html-v1) — RICH content: when present the renderer draws these
  // structured blocks (headings, paragraphs with bold/italic/underline runs, bulleted and
  // numbered lists) INSTEAD of `blocks`. The domain converts its allowlisted content into
  // this shape; the renderer never sees HTML and never fetches anything.
  rich_blocks?: RichBlock[];
  // A1 §2.4 — optional letterhead: the FROZEN logo bytes (read by the domain from the
  // version's TemplateAsset) + an optional organisation name drawn beside it.
  letterhead?: LetterheadModel;
}

// A styled text run. `text` may contain '\n' (a <br> or a multi-line field value) — a
// hard line break inside the block.
export interface RichRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface RichListItem {
  runs: RichRun[];
  // Nested lists inside the item (rendered after the item's own runs, one level deeper).
  children: RichBlock[];
}

export type RichBlock =
  | { kind: 'heading'; runs: RichRun[] }
  | { kind: 'paragraph'; runs: RichRun[] }
  | { kind: 'list'; ordered: boolean; items: RichListItem[] };

export interface LetterheadModel {
  image_bytes: Uint8Array;
  image_format: 'PNG' | 'JPG';
  // sha256 of image_bytes — what the provenance manifest records instead of the bytes.
  image_sha256: string;
  name: string | null;
}

export interface SignatureBlockModel {
  printed_name: string;
}

// M-A6 §3.3 — one SIGNER role's block. `label` is the role label printed above the block
// (validated printable Latin-1 at authoring, so the standard fonts can draw it).
export interface SignatureRoleBlockModel {
  role_key: string;
  label: string;
}

// Where the renderer drew each signature-block field (PDF user space: 0-based page,
// bottom-left origin, points) — the geometry an e-sign envelope needs to place
// SIGNATURE / SIGNER_NAME / SIGN_DATE fields over the frozen artifact.
export interface SignatureFieldPlacement {
  field_type: 'SIGNATURE' | 'SIGNER_NAME' | 'SIGN_DATE';
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  // M-A6 §3.3 — the SIGNER role this placement belongs to (multi-role blocks only;
  // absent for the single fixed block).
  role_key?: string;
}

// A resolved field placement for the UPLOADED_PDF overlay path.
//
// DOC-4 B1 — placements carry a `kind`: TEXT (default; existing drawText path,
// used for typed signatures/date/initials) or IMAGE (a DRAWN/UPLOADED signature
// image stamped via embedPng/embedJpg + drawImage). Executed-document production
// (R-4-3) maps each filled esign SignatureField to one of these.
export interface PreparedField {
  field_key: string;
  page_number: number; // 0-based
  x: number;
  y: number;
  // M-A6 §1 — MARK draws a vector check box (no font glyph): a box, plus a
  // vector check when `checked`. Used for CHECKBOX and ACKNOWLEDGEMENT fields so
  // their stored values never print as text.
  kind?: 'TEXT' | 'IMAGE' | 'MARK'; // default TEXT
  // MARK placement — required when kind === 'MARK'
  checked?: boolean;
  // TEXT placement
  value?: string;
  size?: number;
  // IMAGE placement (DOC-4) — required when kind === 'IMAGE'
  image_bytes?: Uint8Array;
  image_format?: 'PNG' | 'JPG';
  width?: number;
  height?: number;
  // PX-2 (additive) — signature presentation. Absent ⇒ the placement renders
  // exactly as before. `font: 'SCRIPT'` draws TEXT in the embedded handwriting
  // font, fitted to the field box (width/height). `stamp` frames a signature
  // DocuSign-style: a bracket, the label (e.g. "Signed by:") and a short
  // signature id beneath. Pure presentation — the stored values, evidence
  // manifest and certificate are unchanged.
  font?: 'SCRIPT';
  stamp?: { label: string; id: string };
}

// Durable provenance — the AUTHORITATIVE reproducibility proof (byte-equality is
// a validated goal, not the legal anchor). See directive R-2-4.
export interface RenderProvenance {
  renderer: 'PDF_LIB';
  renderer_version: string;
  template_version_id?: string;
  render_manifest_sha256: string;
  source_artifact_sha256?: string;
  output_sha256: string;
}

export interface RenderedOutput {
  bytes: Uint8Array;
  sha256: string;
  page_count: number;
  provenance: RenderProvenance;
  // B2 — present iff the model carried a signature_block (or, M-A6, signature_blocks).
  signature_fields?: SignatureFieldPlacement[];
}

export interface PrepareFromSourceOptions {
  template_version_id?: string;
}

export interface DocumentRenderingPort {
  // GENERATED path: governed render model -> deterministic PDF.
  renderGenerated(model: RenderModel): Promise<RenderedOutput>;
  // UPLOADED_PDF path: immutable source PDF + resolved overlays -> execution-ready PDF.
  prepareFromSource(
    sourcePdf: Uint8Array,
    placements: PreparedField[],
    opts?: PrepareFromSourceOptions,
  ): Promise<RenderedOutput>;
}
