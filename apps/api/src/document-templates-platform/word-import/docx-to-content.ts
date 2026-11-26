import mammoth from 'mammoth';

import { checkDocx, prepareDocx } from './docx-package.js';
import { PAGE_BREAK_CLASS, TITLE_CLASS, mapWordHtml, type WordContent } from './map-word-html.js';
import { WORD_IMPORT_TIMEOUT_MS, WordImportRefusedError, type WordImportWarning } from './word-import.constants.js';

// TEMPLATE-IMPORT-1 (Directive v1.1 LOCKED, R-1: in the api process) — a .docx file → the
// proposed rtr-html-v2 content of a DRAFT (title + html + warnings). Order: file safety on the
// raw bytes (W-2) → prepare the package (text boxes out; comments / headers / footers counted)
// → mammoth (external file access off, no embedded style map, image bytes never read) → the
// pure mapper (W-3). The whole conversion is bounded by WORD_IMPORT_TIMEOUT_MS.

const STYLE_MAP = [
  `p[style-name='Title'] => p.${TITLE_CLASS}:fresh`,
  `br[type='page'] => hr.${PAGE_BREAK_CLASS}`,
  'u => u',
];

// Images are never stored (W-2): the converter never reads the image bytes; the mapper drops
// the empty <img> and counts it.
const NO_IMAGE = mammoth.images.imgElement(() => Promise.resolve({ src: '' }));

export function fileTitle(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.docx$/i, '').trim();
  return base === '' ? 'Imported document' : base.slice(0, 200);
}

export async function convertDocx(filename: string, bytes: Uint8Array, timeoutMs = WORD_IMPORT_TIMEOUT_MS): Promise<WordContent & { title: string }> {
  checkDocx(filename, bytes);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new WordImportRefusedError('import_timeout', { timeout_ms: timeoutMs })), timeoutMs);
  });
  const work = (async () => {
    const pkg = await prepareDocx(bytes);
    let html: string;
    try {
      const res = await mammoth.convertToHtml(
        { buffer: pkg.buffer },
        { styleMap: STYLE_MAP, includeEmbeddedStyleMap: false, externalFileAccess: false, convertImage: NO_IMAGE, ignoreEmptyParagraphs: true },
      );
      html = res.value;
    } catch {
      throw new WordImportRefusedError('import_unreadable');
    }
    const extra: WordImportWarning[] = [
      ...(pkg.textBoxes > 0 ? [{ code: 'text_box_dropped' as const, count: pkg.textBoxes }] : []),
      ...(pkg.comments > 0 ? [{ code: 'comment_dropped' as const, count: pkg.comments }] : []),
      ...(pkg.headerFooters > 0 ? [{ code: 'header_footer_dropped' as const, count: pkg.headerFooters }] : []),
    ];
    const mapped = mapWordHtml(html, extra);
    return { ...mapped, title: mapped.title ?? fileTitle(filename) };
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => undefined); // a timed-out conversion finishes in the background, unobserved
  }
}
