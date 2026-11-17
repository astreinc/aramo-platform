// UAT SIG-03 — a small field's extra touch area never reaches a neighbouring field.
import { fieldHitSlop, type FieldRect } from '../fieldHitSlop';

const MIN = 44;

describe('fieldHitSlop', () => {
  it('a lone small box gets the full minimum touch area', () => {
    const b: FieldRect = { left: 50, top: 100, width: 8, height: 8 };
    expect(fieldHitSlop(b, [b], MIN)).toEqual({ top: 18, bottom: 18, left: 18, right: 18 });
  });

  it('a field already at the minimum gets none', () => {
    const b: FieldRect = { left: 0, top: 0, width: 200, height: 44 };
    expect(fieldHitSlop(b, [b], MIN)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('a "Yes" box 12 px above "No": each stops halfway, so the areas never overlap', () => {
    // 14 pt boxes 29 pt apart on a phone (scale 0.55): 8 px boxes, 8 px gap.
    const yes: FieldRect = { left: 47, top: 100, width: 8, height: 8 };
    const no: FieldRect = { left: 47, top: 116, width: 8, height: 8 };
    const sYes = fieldHitSlop(yes, [yes, no], MIN);
    const sNo = fieldHitSlop(no, [yes, no], MIN);
    expect(sYes.bottom).toBe(4);
    expect(sNo.top).toBe(4);
    expect(yes.top + yes.height + sYes.bottom).toBeLessThanOrEqual(no.top - sNo.top);
    // Sideways and on the open side the full touch area remains.
    expect(sYes.top).toBe(18);
    expect(sYes.left).toBe(18);
    expect(sNo.bottom).toBe(18);
  });

  it('neighbours side by side limit left / right only', () => {
    const a: FieldRect = { left: 0, top: 0, width: 10, height: 10 };
    const b: FieldRect = { left: 20, top: 0, width: 10, height: 10 };
    expect(fieldHitSlop(a, [a, b], MIN)).toEqual({ top: 17, bottom: 17, left: 17, right: 5 });
  });

  it('a field far away does not limit anything', () => {
    const a: FieldRect = { left: 0, top: 0, width: 10, height: 10 };
    const far: FieldRect = { left: 300, top: 400, width: 10, height: 10 };
    expect(fieldHitSlop(a, [a, far], MIN)).toEqual({ top: 17, bottom: 17, left: 17, right: 17 });
  });
});
