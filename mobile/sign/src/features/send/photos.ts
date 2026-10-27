// Photos source (M-A4 §5.2, A12): pick one or more images from the photo library and turn
// them into ONE PDF on the device, through the same image-to-PDF path as the scanner
// (scanToPdf.ts). Uploads stay PDF only (M-A3 §8): nothing but the composed PDF leaves
// the phone.
//
// The picker hands back each image as JPEG: iOS always exports `base64` as JPEG (HEIC and
// PNG are re-encoded), and Android's compressed export is JPEG (EXIF orientation applied
// by the loader). The composition honours any EXIF orientation still present. Temporary
// copies the picker made are deleted as soon as they are read.
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';

import { base64Decode } from '../../util/bytes';
import { MAX_UPLOAD_BYTES } from './fileValidation';
import { composeScanPdf } from './scanToPdf';
import type { SourceResult } from './sources';

/** At most this many photos make one document (each is one page). */
export const MAX_PHOTOS = 20;
/** JPEG re-encode quality for the export (matches the scanner's 85). */
export const PHOTO_QUALITY = 0.85;

export const PHOTO_NOT_READABLE =
  'One of these photos couldn’t be read. Try again with different photos.';
export const PHOTOS_TOO_LARGE =
  'These photos make a PDF larger than 25 MB. Choose fewer photos.';
export const PHOTOS_NOT_SAVED = 'The photos couldn’t be turned into a PDF. Try again.';

export function photosTitle(now: Date = new Date()): string {
  return `Photos ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function deleteQuietly(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // a file the OS already cleaned up
  }
}

async function photoBytes(asset: ImagePicker.ImagePickerAsset): Promise<Uint8Array> {
  if (asset.base64) return base64Decode(asset.base64);
  return new File(asset.uri).bytes();
}

/** Pick photos and compose them, in the order chosen, into one PDF. */
export async function pickPhotosToPdf(now: Date = new Date()): Promise<SourceResult> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: MAX_PHOTOS,
    orderedSelection: true,
    allowsEditing: false,
    quality: PHOTO_QUALITY,
    base64: true,
    exif: false,
  });
  if (res.canceled || !res.assets?.length) return { kind: 'cancelled' };
  const assets = res.assets.filter((a) => a.type !== 'video');
  try {
    if (assets.length === 0) return { kind: 'cancelled' };
    const jpegs: Uint8Array[] = [];
    for (const a of assets) {
      const bytes = await photoBytes(a);
      if (!isJpeg(bytes)) return { kind: 'refused', message: PHOTO_NOT_READABLE };
      jpegs.push(bytes);
    }
    let pdf: ReturnType<typeof composeScanPdf>;
    try {
      pdf = composeScanPdf(jpegs);
    } catch {
      return { kind: 'refused', message: PHOTO_NOT_READABLE };
    }
    if (pdf.bytes.length > MAX_UPLOAD_BYTES) return { kind: 'refused', message: PHOTOS_TOO_LARGE };
    const title = photosTitle(now);
    return { kind: 'document', title, filename: `${title}.pdf`, bytes: pdf.bytes, pages: pdf.pages };
  } catch {
    return { kind: 'refused', message: PHOTOS_NOT_SAVED };
  } finally {
    for (const a of res.assets) deleteQuietly(a.uri);
  }
}
