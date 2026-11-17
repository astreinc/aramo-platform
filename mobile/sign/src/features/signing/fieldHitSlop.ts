// UAT SIG-03 — the touch area around a small field on the signing page.
//
// A field smaller than the minimum touch size gets extra touch area (hitSlop) so it is
// easy to tap. Applied blindly, two small fields close together — a "Yes" and a "No"
// check box 22 pt apart, about 12 px on a phone — get overlapping touch areas, and a
// tap meant for one toggles the other. The extra area therefore stops halfway to the
// nearest neighbouring field on that side; it never reaches into another field's area.

export interface FieldRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HitSlop {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

export function fieldHitSlop(box: FieldRect, others: readonly FieldRect[], minTouch: number): HitSlop {
  const v = Math.max(0, (minTouch - box.height) / 2);
  const h = Math.max(0, (minTouch - box.width) / 2);
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  let top = v;
  let below = v;
  let left = h;
  let rightSlop = h;
  for (const o of others) {
    if (o === box) continue;
    const oRight = o.left + o.width;
    const oBottom = o.top + o.height;
    // Neighbours above / below: they share some horizontal span (with this field's
    // horizontal touch area included, so corner taps cannot land on them either).
    if (overlaps(box.left - h, right + h, o.left, oRight)) {
      if (oBottom <= box.top) top = Math.min(top, (box.top - oBottom) / 2);
      if (o.top >= bottom) below = Math.min(below, (o.top - bottom) / 2);
    }
    // Neighbours left / right: they share some vertical span.
    if (overlaps(box.top - v, bottom + v, o.top, oBottom)) {
      if (oRight <= box.left) left = Math.min(left, (box.left - oRight) / 2);
      if (o.left >= right) rightSlop = Math.min(rightSlop, (o.left - right) / 2);
    }
  }
  return { top, bottom: below, left, right: rightSlop };
}
