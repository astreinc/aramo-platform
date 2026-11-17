// Signature images shared by the guest signing page and the workspace (UAT SIG-05).
// Pure canvas helpers: no session, no API, no workspace code — so the guest zone may
// import this module (zones.spec.ts bans only @aramo/* and ../workspace there).

/** The script face a typed mark is drawn in (guest index.css / workspace styles.css @font-face). */
export const SIGNATURE_FONT_STACK = "'Aramo Signature', 'Segoe Script', 'Brush Script MT', cursive";

/** The drawn canvas as a PNG trimmed to the ink, so the stamp fills its field. */
export function trimmedSignaturePng(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas.toDataURL('image/png');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas.toDataURL('image/png');
  const pad = 6;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(width, maxX + pad + 1) - sx;
  const sh = Math.min(height, maxY + pad + 1) - sy;
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d')?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/png');
}

/**
 * A typed mark as a PNG in the script face (the server stores an image with every saved
 * mark, M-A3 §4). Waits for the face to load so the image is not drawn in a fallback.
 */
export async function typedSignaturePng(text: string): Promise<string> {
  try {
    await document.fonts?.load(`48px 'Aramo Signature'`);
  } catch {
    // A missing face falls back to the next font in the stack.
  }
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas.toDataURL('image/png');
  ctx.font = `48px ${SIGNATURE_FONT_STACK}`;
  ctx.fillStyle = '#151A22';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, canvas.height / 2, canvas.width - 32);
  return trimmedSignaturePng(canvas);
}

/** "Ravi Shankar" → "RS" (at most three letters), as the app derives initials. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 3);
}
