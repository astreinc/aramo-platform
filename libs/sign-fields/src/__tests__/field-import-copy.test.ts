// FIELD-PARITY-1 P2-5 / P2-6 — the upload options' words and the import-result copy, shared by
// every UI (runs under vitest and mobile Jest: globals only).
import { FIELD_IMPORT_WARNING_CODES, FIELD_IMPORT_WARNING_COPY, TEXT_TAG_HELP, UPLOAD_OPTION_COPY, fieldImportSummary, fieldImportWarningText } from '../index.js';

describe('upload option copy (P2-5 / P2-6)', () => {
  it('every warning code has plain-language copy', () => {
    expect(Object.keys(FIELD_IMPORT_WARNING_COPY).sort()).toEqual([...FIELD_IMPORT_WARNING_CODES].sort());
    for (const c of FIELD_IMPORT_WARNING_CODES) expect(fieldImportWarningText(c).length).toBeGreaterThan(10);
    expect(fieldImportWarningText('from_a_newer_server')).toBe('Something in the PDF could not be imported.');
  });
  it('names the two options and carries the short text-tag syntax', () => {
    expect(UPLOAD_OPTION_COPY.import_fields.label).toBe('Import fields from a fillable PDF');
    expect(UPLOAD_OPTION_COPY.apply_text_tags.label).toBe('Apply text tags ({{…}})');
    expect(TEXT_TAG_HELP.syntax).toBe('{{type:role[:required|optional][:label=Caption]}}');
  });
  it('summarises a result', () => {
    expect(fieldImportSummary({ fields: [1, 2, 3], warnings: [1], stripped: ['/AcroForm'] })).toBe('3 fields added · 1 warning · active content removed');
    expect(fieldImportSummary({ fields: [], warnings: [], stripped: [] })).toBe('No fields were added');
  });
});
