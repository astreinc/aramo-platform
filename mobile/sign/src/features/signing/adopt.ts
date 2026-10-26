// Adopted signatures and initials are PNG only (directive §6, §7 C-19; M-A3 §4): typed
// names and drawn strokes are both rendered on the device and rasterized with
// react-native-view-shot. The saved default (/v1/sign/me/signature, /me/initials) is a
// convenience; every signing still submits its value through the fill call.
import type { RefObject } from 'react';
import { Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import type { WorkspaceClient } from '../../api/workspaceClient';
import type { AdoptedMark, SignatureMethod } from './signingMachine';

export type AdoptTarget = 'SIGNATURE' | 'INITIALS';

/** The script face for typed signatures (system fonts; no font file shipped). */
export const SCRIPT_FONT = Platform.select({
  ios: 'Snell Roundhand',
  android: 'cursive',
  default: undefined,
});
/** Stable key stored with a TYPED default (server pattern ^[a-z0-9][a-z0-9_-]{0,39}$). */
export const SCRIPT_FONT_KEY = 'system-script';

const PNG_MAGIC_B64 = 'iVBORw0KGgo';
/** The server's limit for a saved image (256 KiB); a larger capture is refused locally. */
export const MAX_IMAGE_BYTES = 256 * 1024;

/** A PNG data URL from a base64 capture; anything that is not a PNG is refused. */
export function pngDataUrl(base64OrDataUrl: string): string {
  const b64 = base64OrDataUrl.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');
  if (!b64.startsWith(PNG_MAGIC_B64)) throw new Error('not a PNG image');
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES) throw new Error('image too large');
  return `data:image/png;base64,${b64}`;
}

export type Capture = (ref: RefObject<unknown>) => Promise<string>;

/** Rasterize a rendered view (typed preview or drawn strokes) to a PNG data URL. */
export const captureViewAsPng: Capture = async (ref) => {
  const b64 = await captureRef(ref as RefObject<never>, { format: 'png', result: 'base64' });
  return pngDataUrl(b64);
};

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 3);
}

export interface SavedMark {
  readonly kind: SignatureMethod;
  readonly typed_name: string | null;
  readonly font_key: string | null;
  readonly image_data_url: string;
  readonly updated_at: string;
}

export interface SavedMarks {
  readonly signature: SavedMark | null;
  readonly initials: SavedMark | null;
}

export async function loadSavedMarks(workspace: WorkspaceClient): Promise<SavedMarks> {
  const r = await workspace.call('/v1/sign/me/signature', 'get', {});
  return {
    signature: (r.signature as SavedMark | null) ?? null,
    initials: (r.initials as SavedMark | null) ?? null,
  };
}

/** PUT the default signature or initials (PNG data URL; TYPED carries name + font key). */
export async function saveDefaultMark(
  workspace: WorkspaceClient,
  target: AdoptTarget,
  mark: AdoptedMark,
  typedName?: string,
): Promise<void> {
  const body =
    mark.method === 'TYPED'
      ? {
          kind: 'TYPED' as const,
          typed_name: (typedName ?? '').trim().slice(0, 100),
          font_key: SCRIPT_FONT_KEY,
          image_data_url: mark.dataUrl,
        }
      : { kind: 'DRAWN' as const, image_data_url: mark.dataUrl };
  if (target === 'SIGNATURE') await workspace.call('/v1/sign/me/signature', 'put', { body });
  else await workspace.call('/v1/sign/me/initials', 'put', { body });
}

export async function deleteDefaultMark(
  workspace: WorkspaceClient,
  target: AdoptTarget,
): Promise<void> {
  if (target === 'SIGNATURE') await workspace.call('/v1/sign/me/signature', 'delete', {});
  else await workspace.call('/v1/sign/me/initials', 'delete', {});
}

export function markFromSaved(saved: SavedMark | null): AdoptedMark | null {
  if (!saved || !/^data:image\/(png|jpeg);base64,/.test(saved.image_data_url)) return null;
  return { dataUrl: saved.image_data_url, method: saved.kind };
}

export function savedKindLabel(saved: SavedMark | null): string {
  if (!saved) return 'Not set';
  return saved.kind === 'TYPED' ? 'Typed' : 'Drawn';
}
