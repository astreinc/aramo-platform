import { describe, expect, it } from 'vitest';

import { buildDirectory } from './skill-directory';
import { buildProposalDiff, diffTitle, parseProposal, proposalSummary } from './proposal-diff';
import { ALL_SKILLS, K8S, REQUIRES_DOCKER, proposal } from './skill-fixtures';

const dir = buildDirectory(ALL_SKILLS, true, () => undefined);

describe('proposal diff (human rendering, never raw JSON)', () => {
  it('ALIAS: existing aliases plain, the proposed alias "+" with its type label', () => {
    const p = proposal('p1');
    const parsed = parseProposal(p);
    expect(proposalSummary(p, dir)).toBe('“k8s admin” → Kubernetes');
    expect(diffTitle(parsed, dir)).toBe('Aliases of Kubernetes');
    expect(buildProposalDiff(p, parsed, { aliases: [K8S] }, dir)).toEqual([
      { key: 'a-k8s', kind: 'same', text: 'K8s', sub: 'Abbreviation' },
      { key: 'proposed', kind: 'added', text: 'k8s admin', sub: 'Common name' },
    ]);
  });

  it('RELATIONSHIP: names (never ids), type label and direction', () => {
    const p = proposal('p2', {
      proposal_type: 'RELATIONSHIP',
      payload: { source_skill_id: 's-kube', target_skill_id: 's-terr', relationship_type: 'COMPATIBLE_WITH', source: 'AI_RECOMMENDED' },
    });
    const parsed = parseProposal(p);
    expect(proposalSummary(p, dir)).toBe('Kubernetes ↔ Terraform');
    expect(diffTitle(parsed, dir)).toBe('Relationships of Kubernetes');
    expect(buildProposalDiff(p, parsed, { relationships: [REQUIRES_DOCKER] }, dir)).toEqual([
      { key: 'r-1', kind: 'same', text: 'Docker', sub: 'Requires' },
      { key: 'proposed', kind: 'added', text: 'Terraform', sub: 'Compatible with · symmetric' },
    ]);
  });

  it('a directed relationship summary reads →', () => {
    const p = proposal('p3', {
      proposal_type: 'RELATIONSHIP',
      payload: { source_skill_id: 's-terr', target_skill_id: 's-kube', relationship_type: 'BUILT_ON', source: 'AI_RECOMMENDED' },
    });
    expect(proposalSummary(p, dir)).toBe('Terraform → Kubernetes');
  });

  it('an accepted proposal does not list its applied row twice', () => {
    const p = proposal('p1', { status: 'ACCEPTED', applied_entity_id: 'a-new' });
    const applied = { ...K8S, id: 'a-new', alias: 'k8s admin', alias_type: 'COMMON_NAME' as const };
    const rows = buildProposalDiff(p, parseProposal(p), { aliases: [K8S, applied] }, dir);
    expect(rows.map((r) => r.text)).toEqual(['K8s', 'k8s admin']);
  });

  it('a payload that does not parse is INVALID (no diff rows)', () => {
    const p = proposal('p4', { payload: { alias: 'x', alias_type: 'SYNONYM', skill_id: 's-kube' } });
    const parsed = parseProposal(p);
    expect(parsed.kind).toBe('INVALID');
    expect(buildProposalDiff(p, parsed, {}, dir)).toEqual([]);
  });
});
