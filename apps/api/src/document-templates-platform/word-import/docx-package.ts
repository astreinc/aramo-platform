import JSZip from 'jszip';

import {
  WORD_IMPORT_MAX_FILE_BYTES,
  WORD_IMPORT_MAX_UNZIPPED_BYTES,
  WORD_IMPORT_MAX_ZIP_ENTRIES,
  WordImportRefusedError,
} from './word-import.constants.js';

// TEMPLATE-IMPORT-1 W-2 — file safety for an uploaded .docx (a zip; nothing in it is executed).
//
// The checks run on the RAW bytes before anything is inflated:
//   1. the file name ends in .docx (.doc / .docm / .dotx / .rtf and anything else are refused);
//   2. at most 10 MB;
//   3. an OLE compound file is an encrypted Office package (or a legacy .doc) — refused;
//   4. a ZIP: the central directory is read by hand (no inflating) for the entry count (≤ 2,000)
//      and the declared unzipped total (≤ 50 MB; a ZIP64 archive is refused as too large);
//   5. it holds word/document.xml and no vbaProject.bin (macros).
// Only then is the package opened (JSZip) to prepare it for mammoth (docx-to-content.ts).

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface DocxEntryInfo {
  readonly names: readonly string[];
  readonly unzippedBytes: number;
}

/** Read the zip central directory (names + declared sizes) without inflating anything. */
export function readZipDirectory(bytes: Uint8Array): DocxEntryInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 + 65,535 bytes.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new WordImportRefusedError('import_unreadable');
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new WordImportRefusedError('import_unzipped_too_large');
  if (total > WORD_IMPORT_MAX_ZIP_ENTRIES) throw new WordImportRefusedError('import_too_many_entries', { entries: total, max: WORD_IMPORT_MAX_ZIP_ENTRIES });
  if (cdOffset + cdSize > bytes.byteLength) throw new WordImportRefusedError('import_unreadable');
  const names: string[] = [];
  let unzipped = 0;
  let p = cdOffset;
  const decoder = new TextDecoder();
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== ZIP_CENTRAL) throw new WordImportRefusedError('import_unreadable');
    const size = view.getUint32(p + 24, true);
    if (size === 0xffffffff) throw new WordImportRefusedError('import_unzipped_too_large');
    unzipped += size;
    if (unzipped > WORD_IMPORT_MAX_UNZIPPED_BYTES) {
      throw new WordImportRefusedError('import_unzipped_too_large', { max_bytes: WORD_IMPORT_MAX_UNZIPPED_BYTES });
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, unzippedBytes: unzipped };
}

/** W-2 — refuse anything that is not a safe .docx; returns the package's entry names. */
export function checkDocx(filename: string, bytes: Uint8Array): DocxEntryInfo {
  if (!/\.docx$/i.test(filename.trim())) throw new WordImportRefusedError('import_file_type');
  if (bytes.byteLength > WORD_IMPORT_MAX_FILE_BYTES) {
    throw new WordImportRefusedError('import_too_large', { bytes: bytes.byteLength, max_bytes: WORD_IMPORT_MAX_FILE_BYTES });
  }
  if (bytes.byteLength >= 8 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
    // An encrypted .docx is an OLE container holding an "EncryptedPackage" stream; any other
    // OLE file (a legacy .doc renamed) is the wrong type.
    const ascii = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024 * 1024))).toString('latin1');
    const utf16 = Buffer.from('EncryptedPackage', 'utf16le').toString('latin1');
    throw new WordImportRefusedError(ascii.includes(utf16) ? 'import_encrypted' : 'import_file_type');
  }
  if (bytes.byteLength < 4 || new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== ZIP_LOCAL) {
    throw new WordImportRefusedError('import_file_type');
  }
  const info = readZipDirectory(bytes);
  if (info.names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) throw new WordImportRefusedError('import_macros');
  if (!info.names.includes('word/document.xml')) throw new WordImportRefusedError('import_file_type');
  return info;
}

export interface PreparedDocx {
  /** The package handed to mammoth: text boxes removed from the body (W-3). */
  readonly buffer: Buffer;
  readonly textBoxes: number;
  readonly comments: number;
  /** Header / footer parts that hold text (mammoth never reads them). */
  readonly headerFooters: number;
}

const TEXT_BOX_RE = /<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g;
const CHOICE_RE = /<mc:Choice\b[\s\S]*?<\/mc:Choice>/g;

/**
 * Open the checked package and prepare it for mammoth. mammoth reads text-box content as
 * ordinary paragraphs and ignores comments, headers and footers; W-3 drops all four with a
 * warning, so the text boxes are removed from word/document.xml here and the others counted.
 */
export async function prepareDocx(bytes: Uint8Array): Promise<PreparedDocx> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new WordImportRefusedError('import_unreadable');
  }
  const doc = zip.file('word/document.xml');
  if (doc === null) throw new WordImportRefusedError('import_file_type');
  const xml = await doc.async('string');
  // A text box is written twice (mc:Choice for new Word, mc:Fallback VML for old readers);
  // count it once: the occurrences outside mc:Choice.
  const textBoxes = (xml.replace(CHOICE_RE, '').match(/<w:txbxContent\b/g) ?? []).length;
  if (textBoxes > 0) zip.file('word/document.xml', xml.replace(TEXT_BOX_RE, ''));
  const commentsXml = await zip.file('word/comments.xml')?.async('string');
  const comments = commentsXml === undefined ? 0 : (commentsXml.match(/<w:comment\b/g) ?? []).length;
  let headerFooters = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/i.test(name)) continue;
    const part = await zip.file(name)?.async('string');
    if (part !== undefined && /<w:t(\s[^>]*)?>[^<]*\S/.test(part)) headerFooters += 1;
  }
  const buffer = textBoxes > 0 ? await zip.generateAsync({ type: 'nodebuffer' }) : Buffer.from(bytes);
  return { buffer, textBoxes, comments, headerFooters };
}
