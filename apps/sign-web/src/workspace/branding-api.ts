import { apiClient } from '@aramo/fe-foundation';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Settings → Branding client
// (/v1/sign/sender/branding). The backend decides availability, plan entitlement and who may
// edit (can_edit); this module never decides access.

export interface Branding {
  // `sign.branding` launch availability (false = not offered yet; every value null).
  available: boolean;
  // The organization's plan includes branding.
  entitled: boolean;
  can_edit: boolean;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo: { url: string; content_type: string; byte_size: number; width: number; height: number } | null;
  updated_at: string | null;
}

export interface BrandingInput {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
}

export const LOGO_MAX_BYTES = 262_144;
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;
export const DEFAULT_PRIMARY = '#022AC0';

const BASE = '/v1/sign/sender/branding';

export const brandingApi = {
  get: () => apiClient.get<Branding>(BASE),
  save: (input: BrandingInput) => apiClient.put<Branding>(BASE, input),
  uploadLogo: (content_type: string, data_base64: string) => apiClient.put<Branding>(`${BASE}/logo`, { content_type, data_base64 }),
  removeLogo: () => apiClient.delete<Branding>(`${BASE}/logo`),
};

/** File → base64 (no data: prefix). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** `#RRGGBB` (upper case) or null. */
export function normalizeHex(v: string): string | null {
  const t = v.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(t) ? t.toUpperCase() : null;
}

/** Black or white text, whichever reads better on the colour (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#FFFFFF' {
  const c = normalizeHex(hex);
  if (c === null) return '#FFFFFF';
  const ch = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}
