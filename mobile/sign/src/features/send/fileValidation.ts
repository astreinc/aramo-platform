// Step 1 source checks (directive §5; M-A3 §8). PDF only by default: a Word file is
// refused with a clear message before any upload; the server refuses it too (400
// unsupported_file_type).
// M-A13 R-4 (#8): when the sender context advertises `word_conversion_enabled`, a .docx /
// .doc file is accepted as is and uploaded; the server converts it to PDF. Other Word-like
// formats (templates, macro files, RTF, ODT) keep today's refusal.
//
// Client Rule Consolidation C3 (audit row 25) — the check itself is @aramo/sign-client's
// checkPickedFile (the web calls the same function; the server enforces the same limits).
import { WORD_COPY } from '@aramo/sign-client';

export {
  MAX_PDF_BYTES as MAX_UPLOAD_BYTES,
  MAX_WORD_BYTES as WORD_MAX_BYTES,
  NOT_PDF_REFUSAL,
  TOO_LARGE_REFUSAL,
  PDF_PICKER_TYPES,
  PICKER_TYPES,
  checkPickedFile,
  convertibleWordName,
  titleFromFilename,
  wordUploadEnabled,
  type FileCheck,
} from '@aramo/sign-client';

export const WORD_REFUSAL: string = WORD_COPY.word_conversion_disabled;
