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
