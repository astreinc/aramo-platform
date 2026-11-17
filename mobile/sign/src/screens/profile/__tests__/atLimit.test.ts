// UAT PRF-02 — a profile field at its limit shows a field-level note (the input stops
// there, so a 201-character City was cut to 200 with no message).
import { atLimit } from '../ProfileScreen';

describe('atLimit', () => {
  it('says so at the limit; nothing below it', () => {
    expect(atLimit('x'.repeat(200), 200)).toBe('Up to 200 characters. Anything longer isn’t kept.');
    expect(atLimit('x'.repeat(199), 200)).toBeNull();
    expect(atLimit('x'.repeat(120), 120)).toContain('Up to 120 characters');
  });
});
