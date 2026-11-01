import { describe, expect, it } from 'vitest';

import {
  BRANDING_LOGO_MAX_BYTES,
  normalizeBrandColor,
  normalizeDisplayName,
  readableTextOn,
  sniffBrandingImage,
  validateBrandingLogo,
} from '../lib/branding/branding-validation.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — branding validation: the
// logo is identified by its bytes (PNG / JPEG only), colours are #RRGGBB, the display name is
// printable Latin-1 (the certificate's standard fonts can draw it).

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

// SOI, an APP0 segment, then SOF0 with height 120 and width 300.
function jpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x01, 0x2c, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

describe('sniffBrandingImage', () => {
  it('reads PNG and JPEG dimensions from the bytes', () => {
    expect(sniffBrandingImage(png(64, 32))).toEqual({ content_type: 'image/png', width: 64, height: 32 });
    expect(sniffBrandingImage(jpeg())).toEqual({ content_type: 'image/jpeg', width: 300, height: 120 });
  });

  it('refuses SVG, GIF and arbitrary bytes', () => {
    expect(sniffBrandingImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffBrandingImage(new TextEncoder().encode('GIF89a\x01\x00\x01\x00'))).toBeNull();
    expect(sniffBrandingImage(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffBrandingImage(new Uint8Array(0))).toBeNull();
  });
});

describe('validateBrandingLogo', () => {
  it('accepts a PNG / JPEG whose bytes match the declared type', () => {
    expect(validateBrandingLogo(png(200, 80), 'image/png')).toEqual({ ok: true, image: { content_type: 'image/png', width: 200, height: 80 } });
    expect(validateBrandingLogo(jpeg(), 'image/jpeg')).toMatchObject({ ok: true });
  });

  it('names each refusal', () => {
    expect(validateBrandingLogo(new Uint8Array(0), 'image/png')).toEqual({ ok: false, reason: 'logo_empty' });
    expect(validateBrandingLogo(new Uint8Array(BRANDING_LOGO_MAX_BYTES + 1), 'image/png')).toEqual({ ok: false, reason: 'logo_too_large' });
    expect(validateBrandingLogo(png(64, 64), 'image/svg+xml')).toEqual({ ok: false, reason: 'logo_type_unsupported' });
    expect(validateBrandingLogo(png(64, 64), 'image/jpeg')).toEqual({ ok: false, reason: 'logo_type_mismatch' });
    expect(validateBrandingLogo(png(15, 64), 'image/png')).toEqual({ ok: false, reason: 'logo_dimensions_invalid' });
    expect(validateBrandingLogo(png(64, 4097), 'image/png')).toEqual({ ok: false, reason: 'logo_dimensions_invalid' });
  });
});

describe('colours and display name', () => {
  it('normalises #RRGGBB to upper case and refuses anything else', () => {
    expect(normalizeBrandColor('#0a7f3f')).toBe('#0A7F3F');
    for (const bad of ['0a7f3f', '#0a7f3', '#0a7f3fz', 'red', 'rgb(0,0,0)', '#0a7f3f;background:url(x)', 42, null]) expect(normalizeBrandColor(bad)).toBeNull();
  });

  it('trims and collapses whitespace; refuses empty, too long and non-Latin-1 names', () => {
    expect(normalizeDisplayName('  Acme   Staffing  ')).toBe('Acme Staffing');
    expect(normalizeDisplayName('Société Générale')).toBe('Société Générale');
    expect(normalizeDisplayName('')).toBeNull();
    expect(normalizeDisplayName('x'.repeat(81))).toBeNull();
    expect(normalizeDisplayName('Acme ✓')).toBeNull();
    expect(normalizeDisplayName('Acme\u0000')).toBeNull();
  });

  it('picks readable text on a brand colour', () => {
    expect(readableTextOn('#022AC0')).toBe('#FFFFFF');
    expect(readableTextOn('#FFEE00')).toBe('#000000');
  });
});
