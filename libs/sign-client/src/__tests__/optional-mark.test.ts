// Runs under vitest and mobile Jest (globals only).
import { optionalMark, optionalSuffix, withOptionalMark } from '../index.js';

// One wording for "you may skip this field" on the web signing page and in the Aramo Sign app:
// only an optional field is marked.
describe('optional mark', () => {
  it('marks an optional field and leaves a required one unmarked', () => {
    expect(withOptionalMark('Has a co-applicant', false)).toBe('Has a co-applicant · optional');
    expect(withOptionalMark('Signature', true)).toBe('Signature');
    expect(optionalMark(false)).toBe(' · optional');
    expect(optionalMark(true)).toBe('');
  });
  it('the entry window says "(optional)" after the name', () => {
    expect(`Notes${optionalSuffix(false)}`).toBe('Notes (optional)');
    expect(`Notes${optionalSuffix(true)}`).toBe('Notes');
  });
});
