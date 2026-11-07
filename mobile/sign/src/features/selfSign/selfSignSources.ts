// M-A14 — one document source for "Sign Document" (Scan · Photos · Files), shared by the
// Add Documents sheet over Home and the Add Documents screen. Word via Files follows
// M-A13 #8 (only while the server converts); chosen photos get the M-A13 #9 edit step.
import { base64Encode } from '../../util/bytes';
import { randomId } from '../../util/ids';
import { SOURCE_UNAVAILABLE } from '../send/AddDocumentsSheet';
import { pickPhotosToPdf } from '../send/photos';
import { pickPdf, scanToPdf, type SourceResult } from '../send/sources';
import { pagesOf } from './selfSignFlow';
import type { SelfDoc } from './selfSignModel';

export type SelfSourceKey = 'scan' | 'photos' | 'files';

export const SELF_SOURCE_LABEL: Record<SelfSourceKey, string> = {
  scan: 'Camera scan',
  photos: 'Photos',
  files: 'Files',
};

export type SelfPick =
  | { readonly kind: 'doc'; readonly doc: SelfDoc; readonly source: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'cancelled' };

export interface SelfPickOptions {
  /** M-A13 #9 — the photo edit step. */
  readonly editPhoto?: Parameters<typeof pickPhotosToPdf>[1];
  /** M-A13 R-4 — Word files while the server converts them. */
  readonly wordAllowed: boolean;
}

export async function pickSelfDoc(key: SelfSourceKey, opts: SelfPickOptions): Promise<SelfPick> {
  let r: SourceResult;
  try {
    r = await (key === 'photos'
      ? pickPhotosToPdf(new Date(), opts.editPhoto)
      : key === 'files'
        ? pickPdf({ wordAllowed: opts.wordAllowed })
        : scanToPdf());
  } catch {
    return { kind: 'refused', message: SOURCE_UNAVAILABLE };
  }
  if (r.kind === 'cancelled') return r;
  if (r.kind === 'refused') return r;
  const base64 = base64Encode(r.bytes);
  return {
    kind: 'doc',
    source: SELF_SOURCE_LABEL[key],
    doc: {
      key: randomId(),
      title: r.title,
      filename: r.filename,
      base64,
      pages: r.pages && r.pages.length > 0 ? r.pages : pagesOf(base64),
      serverId: null,
    },
  };
}
