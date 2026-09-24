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

export class UnsafePdfError extends Error {
  constructor(public readonly reason: string) {
    super(`Uploaded PDF rejected by the safe-upload pipeline: ${reason}`);
    this.name = 'UnsafePdfError';
  }
}
