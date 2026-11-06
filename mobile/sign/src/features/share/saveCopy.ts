// M-A13 #7 — "Save a copy" of a completed agreement's signed PDF.
//   Android: the system "save to" folder picker (Storage Access Framework); each PDF is
//            written into the folder the user chose. Nothing else is kept on the phone.
//   iOS:     the share sheet, where "Save to Files" is offered (same path as Share PDF).
// The PDFs are the same authorized executed copies Share PDF sends (loadCompletedPdfs).
import {
  loadCompletedPdfs,
  pdfFilename,
  refusal,
  shareCompleted,
  SHARE_NOT_ALLOWED,
  SHARE_NOT_READY,
  type ShareDeps,
  type ShareTarget,
} from './shareCompleted';

export interface SaveFolder {
  /** Write base64 PDF bytes as a new file named `filename` in the chosen folder. */
  writePdf(filename: string, base64: string): Promise<void>;
}

export interface SaveFolderPort {
  /** The system folder picker; null when the user backs out. */
  pick(): Promise<SaveFolder | null>;
}

export interface SaveDeps extends ShareDeps {
  readonly platform: 'ios' | 'android' | string;
  readonly folder: SaveFolderPort;
}

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly files: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly message: string };

export const SAVE_FAILED = 'The copy couldn’t be saved there. Try another folder.';

export function savedMessage(files: number): string {
  return files === 1 ? 'Saved a copy.' : `Saved ${files} copies.`;
}

export async function saveCompleted(
  target: ShareTarget | null,
  deps: SaveDeps,
): Promise<SaveOutcome> {
  if (!target) return { kind: 'refused', message: SHARE_NOT_ALLOWED };
  if (deps.platform !== 'android') {
    // iOS: the share sheet carries "Save to Files".
    const r = await shareCompleted(target, deps);
    return r.kind === 'shared' ? { kind: 'saved', files: r.files } : r;
  }
  let pdfs;
  try {
    pdfs = await loadCompletedPdfs(target, deps);
  } catch (e) {
    return refusal(e);
  }
  if (!pdfs || pdfs.length === 0) return { kind: 'refused', message: SHARE_NOT_READY };
  let folder: SaveFolder | null;
  try {
    folder = await deps.folder.pick();
  } catch {
    return { kind: 'refused', message: SAVE_FAILED };
  }
  if (!folder) return { kind: 'cancelled' };
  let saved = 0;
  for (const [i, pdf] of pdfs.entries()) {
    try {
      await folder.writePdf(pdfFilename(pdf.title, i), pdf.base64);
      saved += 1;
    } catch {
      return saved > 0 ? { kind: 'saved', files: saved } : { kind: 'refused', message: SAVE_FAILED };
    }
  }
  return { kind: 'saved', files: saved };
}
