import { describe, expect, it } from 'vitest';

import { studioSigningOf } from './data-source';
import { addRole, renumberRoles, roleKeyFor, signerRolesOf } from './StudioRolesPanel';

// Amendment M-A6 (LOCKED) §3.2 — the Studio's pure role helpers and the stored-roles reader.
describe('Studio roles helpers (M-A6)', () => {
  it('roleKeyFor: lower snake case from the label, starts with a letter, unique', () => {
    expect(roleKeyFor('Hiring Manager', new Set())).toBe('hiring_manager');
    expect(roleKeyFor('2nd party!', new Set())).toBe('nd_party');
    expect(roleKeyFor('***', new Set())).toBe('role');
    expect(roleKeyFor('Client', new Set(['client', 'client_2']))).toBe('client_3');
  });

  it('addRole numbers labels per kind and appends in order; renumberRoles is 1..N', () => {
    const one = addRole(null, 'SIGNER');
    const two = addRole(one, 'SIGNER');
    const three = addRole(two, 'CC');
    expect(three.roles.map((r) => `${r.order}:${r.role_key}:${r.kind}`)).toEqual(['1:signer_1:SIGNER', '2:signer_2:SIGNER', '3:copy_1:CC']);
    expect(three.routing_mode).toBe('PARALLEL');
    expect(renumberRoles([...three.roles].reverse()).map((r) => r.order)).toEqual([1, 2, 3]);
    expect(signerRolesOf(three).map((r) => r.role_key)).toEqual(['signer_1', 'signer_2']);
    expect(signerRolesOf(undefined)).toEqual([]);
  });

  it('studioSigningOf reads a stored signing (sorted by order) and rejects a malformed one', () => {
    const fs = {
      title: 'T',
      html: '<p>x</p>',
      signing: { routing_mode: 'SEQUENTIAL', roles: [{ role_key: 'b', label: 'B', kind: 'SIGNER', order: 2 }, { role_key: 'a', label: 'A', kind: 'SIGNER', order: 1 }] },
    };
    expect(studioSigningOf(fs)?.roles.map((r) => r.role_key)).toEqual(['a', 'b']);
    expect(studioSigningOf({ title: 'T', html: '' })).toBeNull();
    expect(studioSigningOf({ signing: { routing_mode: 'X', roles: [] } })).toBeNull();
    expect(studioSigningOf({ signing: { routing_mode: 'PARALLEL', roles: [{ role_key: 'a', label: 'A', kind: 'VIEWER', order: 1 }] } })).toBeNull();
  });
});
