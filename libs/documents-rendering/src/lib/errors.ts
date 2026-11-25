// DOC-2 rendering/upload domain errors. Mapped at the apps/api composition root:
//   RenderFailedError  -> DOCUMENT_RENDER_FAILED (422)
//   UnsafePdfError     -> DOCUMENT_UPLOAD_UNSAFE (422)
// Kept lib-local so documents-rendering stays HTTP/registry-agnostic.

export class RenderFailedError extends Error {
  constructor(public readonly reason: string) {
    super(`Document render failed: ${reason}`);
    this.name = 'RenderFailedError';
  }
}

// TEMPLATE-FIELDS-1 F-9 — an inline field box wider than the space it sits in (the content width,
// a list item's text width or a table cell's width). Nothing shrinks silently: the render fails.
// The domain refuses such content at save (field_too_wide); this is the renderer's backstop.
export class InlineFieldTooWideError extends RenderFailedError {
  constructor(
    public readonly field_key: string,
    public readonly box_width: number,
    public readonly max_width: number,
  ) {
    super(`field_too_wide: ${field_key} (${box_width}pt) does not fit in ${max_width}pt`);
    this.name = 'InlineFieldTooWideError';
  }
}

// What is wrong with a refused PDF, in terms a person can act on. Servers send it as
// details.pdf_problem so every UI picks its words from the same classification.
export type PdfProblem = 'scripts' | 'password' | 'too_large' | 'too_many_pages' | 'not_pdf' | 'damaged';

export class UnsafePdfError extends Error {
  constructor(
    public readonly reason: string,
    public readonly problem: PdfProblem = 'damaged',
  ) {
    super(`Uploaded PDF rejected by the safe-upload pipeline: ${reason}`);
    this.name = 'UnsafePdfError';
  }
}
