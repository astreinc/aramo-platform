// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 30–31: one set of role labels; a witness must point at a signer.
import { ROLE_LABELS, danglingWitness, duplicateWitness, isWitnessable, roleLabel, witnessTargets, type WitnessRow } from '../index.js';

describe('role labels (row 30, Appendix A)', () => {
  it.each([
    ['SIGNER', 'Signs'],
    ['IN_PERSON_SIGNER', 'Signs in person'],
    ['RECEIVES_COPY', 'Receives a copy'],
    ['WITNESS', 'Witness'],
  ] as const)('%s → %s', (kind, label) => {
    expect(ROLE_LABELS[kind]).toBe(label);
    expect(roleLabel(kind)).toBe(label);
  });
  it('a row without a kind is a signer', () => {
    expect(roleLabel(undefined)).toBe('Signs');
  });
});

describe('the witness rule (row 31)', () => {
  const s: WitnessRow = { key: 's', kind: 'SIGNER' };
  const p: WitnessRow = { key: 'p', kind: 'IN_PERSON_SIGNER' };
  const c: WitnessRow = { key: 'c', kind: 'RECEIVES_COPY' };
  const w = (witnessFor: string | null, key = 'w'): WitnessRow => ({ key, kind: 'WITNESS', witnessFor });

  it.each([
    ['SIGNER', true],
    ['IN_PERSON_SIGNER', true],
    ['RECEIVES_COPY', false],
    ['WITNESS', false],
    [undefined, true],
  ] as const)('isWitnessable(%s) → %s', (kind, ok) => {
    expect(isWitnessable(kind)).toBe(ok);
  });

  it.each([
    ['points at a signer', [s, w('s')], null],
    ['points at an in-person signer', [p, w('p')], null],
    ['no target', [s, w(null)], 'w'],
    ['points at a copy recipient', [s, c, w('c')], 'w'],
    ['points at itself', [s, w('w')], 'w'],
    ['points at a removed recipient', [s, w('gone')], 'w'],
    ['points at another witness', [s, w('s', 'w1'), w('w1', 'w2')], 'w2'],
  ])('%s', (_n, list, dangling) => {
    expect(danglingWitness(list)?.key ?? null).toBe(dangling);
  });

  it('targets: signing recipients other than the witness', () => {
    expect(witnessTargets([s, p, c, w('s')], 'w').map((r) => r.key)).toEqual(['s', 'p']);
  });

  it('one witness per signer', () => {
    expect(duplicateWitness([s, w('s', 'w1'), w('s', 'w2')])?.key).toBe('w2');
    expect(duplicateWitness([s, p, w('s', 'w1'), w('p', 'w2')])).toBeNull();
  });
});
