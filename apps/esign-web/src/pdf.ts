// The worker is referenced as a URL string only (Vite `?url`): the renderer itself
// still loads lazily below.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// PX-V1 §8 — the prepare editor places fields over the RENDERED source PDF
// (pdfjs-dist). Loaded lazily so the console shell, lists and tests never pull
// the renderer; only the editor and preview do.
//
// Geometry: pdfjs reports page size in PDF points (unscaled viewport). Fields on
// the wire are PDF-native (0-based page, bottom-left origin); the editor works in
// a TOP-LEFT frame. toTopLeft / toPdf convert between them for one page height.

import type { PdfPageInfo } from './geometry';

export type { PdfPageInfo };

export interface LoadedPdf {
  pages: PdfPageInfo[];
  render: (pageIndex: number, canvas: HTMLCanvasElement, cssWidth: number) => Promise<void>;
  destroy: () => void;
}

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function pdfjs(): Promise<PdfjsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist');
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })();
  }
  return pdfjsPromise;
}

export async function loadPdf(bytes: ArrayBuffer): Promise<LoadedPdf> {
  const lib = await pdfjs();
  // pdfjs takes ownership of the buffer; pass a copy so callers may reuse theirs.
  const doc = await lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  const pages: PdfPageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height });
  }
  return {
    pages,
    render: async (pageIndex, canvas, cssWidth) => {
      const page = await doc.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const ratio = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    },
    destroy: () => {
      void doc.destroy();
    },
  };
}
