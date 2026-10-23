import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

// TR-14 B2 (§3.2 / §5e) → ATI-SEP-1 T10 WP3b — the negative-shape proof for the
// contracted dossier (now Talent Intelligence's view): NO trust-ordinal numeric
// (no strength, no count) anywhere in the Dossier schemas. The ONLY places a
// number may legally appear are inside `assertion_payload` / a fact `value`
// (opaque claim facts) — deliberately typeless (unconstrained), so the refusal
// walker skips them and they are exempt here too. This complements the
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
    expect(dossierSchemaNames).toContain('DossierFactItem');
    expect(dossierSchemaNames).toContain('DossierIntelligenceStatus');
  });

  it('DossierHead + DossierEvidencePage require intelligence_status (fail-soft enrichment)', () => {
    expect(schemas['DossierHead']!['required']).toContain('intelligence_status');
    expect(schemas['DossierEvidencePage']!['required']).toContain('intelligence_status');
    expect(schemas['DossierIntelligenceStatus']!['enum']).toEqual(['ENABLED', 'NOT_ENTITLED', 'NOT_CONFIGURED', 'UNAVAILABLE']);
    // corroboration is a WORD-shaped boolean, never a source count.
    const fact = (schemas['DossierFactItem']!['properties'] as Node)['corroborated'] as Node;
    expect(fact['type']).toBe('boolean');
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
      assertNoNumeric(v, `${path}.${k}`, underPayload || k === 'assertion_payload' || (k === 'value' && path.endsWith('.properties')));
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

  it('assertion_payload / fact value are the only unconstrained (typeless) passthroughs', () => {
    for (const [schema, key] of [
      ['DossierEvidenceItem', 'assertion_payload'],
      ['DossierContradictionItem', 'assertion_payload'],
      ['DossierFactItem', 'value'],
    ] as const) {
      const prop = (schemas[schema]!['properties'] as Node)[key] as Node;
      expect(prop['type']).toBeUndefined(); // typeless → walker-skipped, numeric-exempt
      expect(typeof prop['description']).toBe('string');
    }
  });
});
