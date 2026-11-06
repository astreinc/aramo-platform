// M-A13 #9 — the image work behind the photo crop step (expo-image-manipulator).
// `prepare` re-renders the picked photo upright (any EXIF orientation applied) so the
// screen and the final crop see the same pixels; `apply` turns and crops it and returns
// JPEG bytes. Every file this writes is in the app cache and is deleted after use.
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { base64Decode } from '../../../util/bytes';
import { cropPixels, totalRotation, type PhotoEdit, type Size } from './photoCrop';

export interface PreparedPhoto extends Size {
  /** An upright copy of the photo in the app cache. */
  readonly uri: string;
}

export interface PhotoEditPort {
  prepare(uri: string): Promise<PreparedPhoto>;
  /** The edited photo as JPEG bytes. */
  apply(photo: PreparedPhoto, edit: PhotoEdit, quality: number): Promise<Uint8Array>;
  discard(uri: string): void;
}

export const nativePhotoEdit: PhotoEditPort = {
  async prepare(uri) {
    const ref = await ImageManipulator.manipulate(uri).renderAsync();
    const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  },
  async apply(photo, edit, quality) {
    const turn = totalRotation(edit) % 360;
    let ref = await (turn === 0
      ? ImageManipulator.manipulate(photo.uri)
      : ImageManipulator.manipulate(photo.uri).rotate(turn)
    ).renderAsync();
    ref = await ImageManipulator.manipulate(ref)
      .crop(cropPixels(edit.crop, { width: ref.width, height: ref.height }))
      .renderAsync();
    const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
    nativePhotoEdit.discard(out.uri);
    if (!out.base64) throw new Error('no image data');
    return base64Decode(out.base64);
  },
  discard(uri) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  },
};
