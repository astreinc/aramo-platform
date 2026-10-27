// Photos source (M-A4 §5.2, A12): picked images become ONE PDF on the device through the
// scanner's image-to-PDF path. The picker and the file system are mocked.
import * as ImagePicker from 'expo-image-picker';

import { readPdfPageSizes } from '../../editor/pdfPageSizes';
import { MAX_UPLOAD_BYTES } from '../fileValidation';
import {
  MAX_PHOTOS,
  PHOTO_NOT_READABLE,
  PHOTOS_TOO_LARGE,
  pickPhotosToPdf,
} from '../photos';
import { base64Encode } from '../../../util/bytes';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

const mockDeleted: string[] = [];
const mockFileBytes = new Map<string, Uint8Array>();
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(u: string) {
      this.uri = u;
    }
    get exists() {
      return true;
    }
    delete() {
      mockDeleted.push(this.uri);
    }
    async bytes() {
      const b = mockFileBytes.get(this.uri);
      if (!b) throw new Error('missing');
      return b;
    }
  },
}));

const launch = ImagePicker.launchImageLibraryAsync as jest.Mock;

/** A minimal baseline JPEG: SOI, SOF0 (w x h, 3 components), EOI. */
function jpeg(w: number, h: number, extra: number = 0): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const out = new Uint8Array(head.length + extra + 2);
  out.set(head);
  out.set([0xff, 0xd9], head.length + extra);
  return out;
}

const asset = (uri: string, bytes: Uint8Array | null, extra: Partial<ImagePicker.ImagePickerAsset> = {}) => ({
  uri,
  width: 0,
  height: 0,
  type: 'image',
  base64: bytes ? base64Encode(bytes) : null,
  ...extra,
});

const NOW = new Date('2026-10-27T10:00:00Z');

beforeEach(() => {
  mockDeleted.length = 0;
  mockFileBytes.clear();
  launch.mockReset();
});

describe('Photos -> one PDF (A12)', () => {
  it('asks the system picker for several images, in the order chosen, as JPEG', async () => {
    launch.mockResolvedValue({ canceled: true, assets: null });
    await pickPhotosToPdf(NOW);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_PHOTOS,
        orderedSelection: true,
        allowsEditing: false,
        base64: true,
      }),
    );
  });

  it('is cancelled when nothing is picked', async () => {
    launch.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickPhotosToPdf(NOW)).toEqual({ kind: 'cancelled' });
  });

  it('composes every picked photo into one PDF document, one page each', async () => {
    launch.mockResolvedValue({
      canceled: false,
      assets: [asset('file:///c/a.jpg', jpeg(1224, 1584)), asset('file:///c/b.jpg', jpeg(3000, 2000))],
    });
    const r = await pickPhotosToPdf(NOW);
    if (r.kind !== 'document') throw new Error(`expected a document, got ${r.kind}`);
    expect(r.filename).toMatch(/^Photos .+\.pdf$/);
    expect(r.title).toBe(r.filename.replace(/\.pdf$/, ''));
    expect(Buffer.from(r.bytes.subarray(0, 8)).toString('latin1')).toBe('%PDF-1.4');
    expect(r.pages).toEqual([
      { width: 612, height: 792 },
      { width: 792, height: 528 },
    ]);
    expect(readPdfPageSizes(r.bytes)).toEqual(r.pages);
    // The picker's temporary copies are removed.
    expect(mockDeleted.sort()).toEqual(['file:///c/a.jpg', 'file:///c/b.jpg']);
  });

  it('reads the file when the picker returned no base64', async () => {
    mockFileBytes.set('file:///c/a.jpg', jpeg(1000, 1000));
    launch.mockResolvedValue({ canceled: false, assets: [asset('file:///c/a.jpg', null)] });
    const r = await pickPhotosToPdf(NOW);
    expect(r.kind).toBe('document');
  });

  it('refuses an image that is not JPEG, and still cleans up', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    launch.mockResolvedValue({
      canceled: false,
      assets: [asset('file:///c/a.jpg', jpeg(100, 100)), asset('file:///c/b.png', png)],
    });
    expect(await pickPhotosToPdf(NOW)).toEqual({ kind: 'refused', message: PHOTO_NOT_READABLE });
    expect(mockDeleted).toHaveLength(2);
  });

  it('refuses a PDF over the 25 MB upload cap', async () => {
    mockFileBytes.set('file:///c/big.jpg', jpeg(4000, 3000, MAX_UPLOAD_BYTES));
    launch.mockResolvedValue({ canceled: false, assets: [asset('file:///c/big.jpg', null)] });
    expect(await pickPhotosToPdf(NOW)).toEqual({ kind: 'refused', message: PHOTOS_TOO_LARGE });
  });

  it('ignores videos', async () => {
    launch.mockResolvedValue({
      canceled: false,
      assets: [asset('file:///c/v.mp4', null, { type: 'video' })],
    });
    expect(await pickPhotosToPdf(NOW)).toEqual({ kind: 'cancelled' });
  });
});
