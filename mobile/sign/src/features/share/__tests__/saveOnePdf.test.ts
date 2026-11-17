// UAT CMP-02 — "Download" the PDF on screen (the certificate of completion): Android
// writes it into the picked folder; iOS hands it to the share sheet (Save to Files).
import { saveOnePdf, SAVE_FAILED, type SaveFolderPort } from '../saveCopy';

const PDF = { title: 'Certificate of completion', base64: 'JVBERi0xLjQK' };

function deps(platform: string, folder: SaveFolderPort) {
  return {
    platform,
    folder,
    files: { writeTemp: jest.fn(async () => 'file:///tmp/c.pdf'), remove: jest.fn() },
    sheet: { available: jest.fn(async () => true), open: jest.fn(async () => undefined) },
  };
}

describe('saveOnePdf', () => {
  it('Android: writes the PDF into the chosen folder', async () => {
    const writePdf = jest.fn(async () => undefined);
    const d = deps('android', { pick: async () => ({ writePdf }) });
    expect(await saveOnePdf(PDF, d)).toEqual({ kind: 'saved', files: 1 });
    expect(writePdf).toHaveBeenCalledWith(expect.stringMatching(/Certificate of completion.*\.pdf$/), PDF.base64);
    expect(d.sheet.open).not.toHaveBeenCalled();
  });

  it('Android: backing out of the picker is a cancel; a write failure says so', async () => {
    expect(await saveOnePdf(PDF, deps('android', { pick: async () => null }))).toEqual({ kind: 'cancelled' });
    const failing = deps('android', { pick: async () => ({ writePdf: async () => { throw new Error('denied'); } }) });
    expect(await saveOnePdf(PDF, failing)).toEqual({ kind: 'refused', message: SAVE_FAILED });
  });

  it('iOS: the share sheet (Save to Files), and the temp file is removed', async () => {
    const d = deps('ios', { pick: async () => null });
    expect(await saveOnePdf(PDF, d)).toEqual({ kind: 'saved', files: 1 });
    expect(d.sheet.open).toHaveBeenCalledWith('file:///tmp/c.pdf', { mimeType: 'application/pdf', dialogTitle: PDF.title });
    expect(d.files.remove).toHaveBeenCalledWith('file:///tmp/c.pdf');
  });
});
