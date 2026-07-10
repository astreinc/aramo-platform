import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

// TR-14 B2 (§3.2 / §5e) — the negative-shape proof for the contracted dossier: NO
// top-level trust-ordinal numeric (no strength, no count) anywhere in the Dossier
// schemas. The ONLY place a number may legally appear is inside `assertion_payload`
// (opaque ledger claim facts) — which is deliberately typeless (unconstrained), so
// the refusal walker skips it and it is exempt here too. This complements the
// refusal walker (which enforces additionalProperties:false + forbidden names but
// not numeric types).

const ATS = resolve(__dirname, '../../../../openapi/ats.yaml');
type Node = Record<string, unknown>;

describe('TR-14 B2 — the dossier wire carries no trust-ordinal numeric', () => {
  const spec = parseYaml(readFileSync(ATS, 'utf8')) as Node;
  const schemas = ((spec['components'] as Node)['schemas'] ?? {}) as Record<string, Node>;
  const dossierSchemaNames = Object.keys(schemas).filter((n) => n.startsWith('Dossier') || n === 'DimensionAssessment');

  it('registers the dossier schemas', () => {
    expect(dossierSchemaNames).toContain('DossierHead');
    expect(dossierSchemaNames).toContain('DossierEvidencePage');
    // TR-12 B2 — the proposal-pointer schema joins the contracted head.
    expect(dossierSchemaNames).toContain('DossierProposalPointer');
  });

  it('DossierHead requires proposal_pointers (TR-12 B2 pointer line)', () => {
    const head = schemas['DossierHead']!;
    expect(head['required']).toContain('proposal_pointers');
    const pointer = schemas['DossierProposalPointer']!;
    // kinds are WORDS (an enum of the three proposal kinds) — never a number.
    const kind = (pointer['properties'] as Node)['kind'] as Node;
    expect(kind['type']).toBe('string');
    expect(Array.isArray(kind['enum'])).toBe(true);
  });

  // Recursively assert no `type: integer|number` appears — EXCEPT under an
  // `assertion_payload` key (the opaque claim-facts passthrough).
  function assertNoNumeric(node: unknown, path: string, underPayload: boolean): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => assertNoNumeric(n, `${path}[${i}]`, underPayload));
      return;
    }
    const obj = node as Node;
    const type = obj['type'];
    const isNumeric =
      type === 'integer' ||
      type === 'number' ||
      (Array.isArray(type) && type.some((t) => t === 'integer' || t === 'number'));
    if (isNumeric && !underPayload) {
      throw new Error(`trust-ordinal numeric found at ${path} (type=${JSON.stringify(type)})`);
    }
    for (const [k, v] of Object.entries(obj)) {
      assertNoNumeric(v, `${path}.${k}`, underPayload || k === 'assertion_payload');
    }
  }

  it('every dossier schema is object-shaped with additionalProperties:false and no top-level ordinal', () => {
    for (const name of dossierSchemaNames) {
      const s = schemas[name]!;
      // object schemas must seal (mirrors the refusal walker).
      if (s['type'] === 'object' || typeof s['properties'] === 'object') {
        expect(s['additionalProperties']).toBe(false);
      }
      expect(() => assertNoNumeric(s, name, false)).not.toThrow();
    }
  });

  it('assertion_payload is the only unconstrained (typeless) passthrough', () => {
    // DossierEvidenceSummary + DossierContradictionItem carry assertion_payload.
    const summary = schemas['DossierEvidenceSummary']!;
    const payload = (summary['properties'] as Node)['assertion_payload'] as Node;
    expect(payload['type']).toBeUndefined(); // typeless → walker-skipped, numeric-exempt
    expect(typeof payload['description']).toBe('string');
  });
});
