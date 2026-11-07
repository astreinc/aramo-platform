// The file picker lists only what can be added: PDFs, plus Word files while the server
// converts them (M-A13 R-4). The picker is mocked; nothing is chosen.
import * as DocumentPicker from 'expo-document-picker';

import { PDF_PICKER_TYPES, PICKER_TYPES } from '../fileValidation';
import { pickPdf } from '../sources';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: class {} }));
jest.mock('react-native-document-scanner-plugin', () => ({
  __esModule: true,
  default: { scanDocument: jest.fn() },
  ResponseType: {},
  ScanDocumentResponseStatus: {},
}));

const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.Mock;

describe('file picker types', () => {
  beforeEach(() => getDocumentAsync.mockReset().mockResolvedValue({ canceled: true, assets: null }));

  it('lists PDFs only while Word upload is off', async () => {
    await pickPdf();
    await pickPdf({ wordAllowed: false });
    for (const [opts] of getDocumentAsync.mock.calls) expect(opts.type).toEqual(PDF_PICKER_TYPES);
    expect(PDF_PICKER_TYPES).toEqual(['application/pdf']);
  });

  it('also lists Word files while the server converts them', async () => {
    await pickPdf({ wordAllowed: true });
    expect(getDocumentAsync.mock.calls[0][0].type).toEqual(PICKER_TYPES);
    expect(PICKER_TYPES.length).toBeGreaterThan(1);
  });
});
