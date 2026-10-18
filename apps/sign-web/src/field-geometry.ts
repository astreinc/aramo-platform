import type { SignField } from './sign-api';

// PX-2 — pure field geometry (no renderer). Fields arrive PDF-native: page_number
// 0-based, points, origin bottom-left, (x, y) the box's lower-left corner.

export const DEFAULT_SIZE: Record<string, [number, number]> = {
  SIGNATURE: [220, 48],
  INITIALS: [60, 30],
  SIGN_DATE: [150, 22],
  SIGNER_NAME: [220, 22],
  TEXT: [220, 22],
  CHECKBOX: [16, 16],
  ACKNOWLEDGEMENT: [400, 26],
};

export interface PageSize {
  width: number;
  height: number;
}

// PDF bottom-left box → CSS percentages of the page (top-left origin).
export function fieldBox(f: Pick<SignField, 'field_type' | 'x' | 'y' | 'width' | 'height'>, page: PageSize): { left: string; top: string; width: string; height: string } {
  const [dw, dh] = DEFAULT_SIZE[f.field_type] ?? [160, 24];
  const w = f.width ?? dw;
  const h = f.height ?? dh;
  const top = page.height - f.y - h;
  const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100))}%`;
  return { left: pct(f.x, page.width), top: pct(top, page.height), width: pct(w, page.width), height: pct(h, page.height) };
}

