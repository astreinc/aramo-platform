import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { type SavedSignatureRow, type SavedSignatureSlot, type SavedSignatureValue, SignSavedSignatureRepository } from '@aramo/sign';

// Aramo Sign Mobile (M-A3 §4 / §9) — the signed-in user's saved default signature
// and initials. A convenience only: every signing still submits its value through
// the fill call, which copies it into the signing record (SignatureField.value +
// signature_method). Deleting a saved value therefore never touches an executed or
// in-progress document. Owned by (tenant, user) from the verified token only.
//
// Refusals (stable details.reason, 400):
//   invalid_signature_kind   kind is not TYPED or DRAWN
//   invalid_typed_name       TYPED without a name (1–100 characters)
//   invalid_font_key         TYPED without a font key (a-z, 0-9, _ or -; up to 40)
//   invalid_image            image_data_url is not a PNG or JPEG data URL (C-19), or its bytes are not that image
//   image_too_large          over 256 KiB, or wider / taller than 2048 pixels

export const SAVED_SIGNATURE_MAX_BYTES = 256 * 1024;
export const SAVED_SIGNATURE_MAX_DIMENSION = 2048;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const FONT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function bad(requestId: string, message: string, reason: string, field?: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason, ...(field !== undefined ? { field } : {}) } });
}

// Pixel size of a PNG (IHDR) or baseline/progressive JPEG (SOFn); null if unreadable.
export function imageDimensions(mime: 'png' | 'jpeg', b: Buffer): { width: number; height: number } | null {
  if (mime === 'png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || sig.some((v, i) => b[i] !== v) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

export function validateSavedSignature(body: unknown, requestId: string): SavedSignatureValue {
  const o = (body ?? {}) as Record<string, unknown>;
  const kind = o['kind'];
  if (kind !== 'TYPED' && kind !== 'DRAWN') throw bad(requestId, 'kind must be TYPED or DRAWN', 'invalid_signature_kind', 'kind');
  let typed_name: string | null = null;
  let font_key: string | null = null;
  if (kind === 'TYPED') {
    const name = typeof o['typed_name'] === 'string' ? o['typed_name'].trim() : '';
    if (name.length === 0 || name.length > 100) throw bad(requestId, 'A typed signature needs a name of at most 100 characters', 'invalid_typed_name', 'typed_name');
    const font = o['font_key'];
    if (typeof font !== 'string' || !FONT_KEY_RE.test(font)) throw bad(requestId, 'A typed signature needs a font', 'invalid_font_key', 'font_key');
    typed_name = name;
    font_key = font;
  }
  const url = o['image_data_url'];
  if (typeof url !== 'string') throw bad(requestId, 'image_data_url must be a PNG or JPEG data URL', 'invalid_image', 'image_data_url');
  if (url.length > Math.ceil((SAVED_SIGNATURE_MAX_BYTES * 4) / 3) + 32) throw bad(requestId, 'The signature image is too large', 'image_too_large', 'image_data_url');
  const m = DATA_URL_RE.exec(url);
  if (m === null) throw bad(requestId, 'image_data_url must be a PNG or JPEG data URL', 'invalid_image', 'image_data_url');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > SAVED_SIGNATURE_MAX_BYTES) throw bad(requestId, 'The signature image is too large', 'image_too_large', 'image_data_url');
  const dims = imageDimensions(m[1] as 'png' | 'jpeg', bytes);
  if (dims === null || dims.width === 0 || dims.height === 0) throw bad(requestId, 'The image is not a valid PNG or JPEG', 'invalid_image', 'image_data_url');
  if (dims.width > SAVED_SIGNATURE_MAX_DIMENSION || dims.height > SAVED_SIGNATURE_MAX_DIMENSION) {
    throw bad(requestId, `The signature image can be at most ${SAVED_SIGNATURE_MAX_DIMENSION} pixels wide and tall`, 'image_too_large', 'image_data_url');
  }
  return { kind, typed_name, font_key, image_data_url: url };
}

export interface SavedSignatureView {
  kind: 'TYPED' | 'DRAWN';
  typed_name: string | null;
  font_key: string | null;
  image_data_url: string;
  updated_at: string;
}

function view(r: SavedSignatureRow | undefined): SavedSignatureView | null {
  return r === undefined ? null : { kind: r.kind, typed_name: r.typed_name, font_key: r.font_key, image_data_url: r.image_data_url, updated_at: r.updated_at.toISOString() };
}

@Injectable()
export class SavedSignatureService {
  constructor(private readonly repo: SignSavedSignatureRepository) {}

  async get(auth: AuthContextType): Promise<{ signature: SavedSignatureView | null; initials: SavedSignatureView | null }> {
    const rows = await this.repo.list(auth.tenant_id, auth.sub);
    return { signature: view(rows.find((r) => r.slot === 'signature')), initials: view(rows.find((r) => r.slot === 'initials')) };
  }

  async put(auth: AuthContextType, slot: SavedSignatureSlot, body: unknown, requestId: string): Promise<SavedSignatureView> {
    const value = validateSavedSignature(body, requestId);
    await this.repo.put(auth.tenant_id, auth.sub, slot, value);
    const saved = (await this.repo.list(auth.tenant_id, auth.sub)).find((r) => r.slot === slot);
    return view(saved)!;
  }

  // Idempotent: deleting an absent value is a no-op (204 either way).
  async remove(auth: AuthContextType, slot: SavedSignatureSlot): Promise<void> {
    await this.repo.remove(auth.tenant_id, auth.sub, slot);
  }
}
