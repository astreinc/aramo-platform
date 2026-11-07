// Step 1 document sources on the device (handoff §4.6; directive §5):
//   - Choose a file: the system document picker (UIDocumentPicker / Storage Access
//     Framework, so OneDrive and Google Drive appear through the OS). PDF only.
//   - Scan a document: the native scanner (VisionKit / ML Kit), composed into one PDF.
// Temporary copies the OS hands us are deleted as soon as they are read.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from 'react-native-document-scanner-plugin';

import type { PageSize } from '../editor/geometry';
import {
  checkPickedFile,
  convertibleWordName,
  PICKER_TYPES,
  titleFromFilename,
} from './fileValidation';
import { composeScanPdf } from './scanToPdf';

export type SourceResult =
  | {
      readonly kind: 'document';
      readonly title: string;
      readonly filename: string;
      readonly bytes: Uint8Array;
      readonly pages?: readonly PageSize[];
      /** M-A13 R-4 — a .docx / .doc the server converts to PDF on upload. */
      readonly word?: true;
    }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'cancelled' };

/** Scanner results can be bare paths; the file API wants URIs. */
export function asFileUri(pathOrUri: string): string {
  return /^[a-z]+:\/\//i.test(pathOrUri) ? pathOrUri : `file://${pathOrUri}`;
}

function deleteQuietly(uri: string): void {
  try {
    const f = new File(asFileUri(uri));
    if (f.exists) f.delete();
  } catch {
    // a file the OS already cleaned up
  }
}

/** Choose a file. M-A13 R-4: `wordAllowed` (sender context) also accepts .docx / .doc. */
export async function pickPdf(opts: { readonly wordAllowed?: boolean } = {}): Promise<SourceResult> {
  const res = await DocumentPicker.getDocumentAsync({
    type: PICKER_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled) return { kind: 'cancelled' };
  const asset = res.assets[0];
  if (!asset) return { kind: 'cancelled' };
  try {
    const bytes = await new File(asset.uri).bytes();
    const check = checkPickedFile({
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size ?? bytes.length,
      head: bytes.subarray(0, 1024),
      wordAllowed: opts.wordAllowed === true,
    });
    if (!check.ok) return { kind: 'refused', message: check.message };
    if (check.word) {
      // Uploaded as is (the server converts it); the name keeps its Word extension.
      const name = convertibleWordName(asset.name, asset.mimeType) ?? asset.name;
      return { kind: 'document', title: titleFromFilename(name), filename: name, bytes, word: true };
    }
    const filename = /\.pdf$/i.test(asset.name) ? asset.name : `${asset.name}.pdf`;
    return { kind: 'document', title: titleFromFilename(asset.name), filename, bytes };
  } finally {
    deleteQuietly(asset.uri);
  }
}

export function scanTitle(now: Date = new Date()): string {
  return `Scan ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export async function scanToPdf(): Promise<SourceResult> {
  const res = await DocumentScanner.scanDocument({
    croppedImageQuality: 85,
    responseType: ResponseType.ImageFilePath,
  });
  if (res.status === ScanDocumentResponseStatus.Cancel || !res.scannedImages?.length) {
    return { kind: 'cancelled' };
  }
  const uris = res.scannedImages;
  try {
    const jpegs: Uint8Array[] = [];
    for (const uri of uris) jpegs.push(await new File(asFileUri(uri)).bytes());
    const pdf = composeScanPdf(jpegs);
    const title = scanTitle();
    return {
      kind: 'document',
      title,
      filename: `${title}.pdf`,
      bytes: pdf.bytes,
      pages: pdf.pages,
    };
  } catch {
    return { kind: 'refused', message: 'The scan couldn’t be saved. Try scanning again.' };
  } finally {
    for (const uri of uris) deleteQuietly(uri);
  }
}
