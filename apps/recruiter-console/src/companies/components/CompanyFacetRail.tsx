import { Icons } from '../../ui';
import {
  RELATIONSHIP_LABELS,
  TIER_LABELS,
  type CompanyFacets,
  type FacetFlag,
  type FacetState,
} from '../company-workspace';

// CompanyFacetRail — the left filter sidebar (mirrors the talent FacetRail
// grammar: rc-facet / rc-fopt). Phase 2: COUNTS are SERVER-COMPUTED over the
// base (scope) set — stable as selections toggle. Groups: Relationship · Tier ·
// Flags · Industry. No health group (omitted).

const RELATIONSHIP_ORDER: readonly string[] = [
  'active',
  'prospect',
  'inactive',
  'do_not_contact',
];
const TIER_ORDER: readonly string[] = ['a', 'b', 'c'];
const FLAG_OPTIONS: readonly { value: FacetFlag; label: string }[] = [
  { value: 'hot', label: 'Hot only' },
  { value: 'quiet', label: 'Quiet 30d+' },
  { value: 'exclusive', label: 'Exclusive' },
  { value: 'off_limits', label: 'Off-limits' },
];

interface CompanyFacetRailProps {
  /** Server-computed facet counts over the scoped base set (null while loading). */
  readonly facets: CompanyFacets | null;
  readonly selected: FacetState;
  readonly onToggleRelationship: (value: string) => void;
  readonly onToggleTier: (value: string) => void;
  readonly onToggleIndustry: (value: string) => void;
  readonly onToggleFlag: (value: FacetFlag) => void;
  readonly onReset: () => void;
}

export function CompanyFacetRail({
  facets,
  selected,
  onToggleRelationship,
  onToggleTier,
  onToggleIndustry,
  onToggleFlag,
  onReset,
}: CompanyFacetRailProps) {
  const bucketCount = (
    buckets: readonly { value: string; count: number }[] | undefined,
    value: string,
  ): number => buckets?.find((b) => b.value === value)?.count ?? 0;

  const flagCount = (flag: FacetFlag): number => {
    if (facets === null) return 0;
    switch (flag) {
      case 'hot':
        return facets.hot;
      case 'quiet':
        return facets.quiet;
      case 'exclusive':
        return facets.exclusivity;
      case 'off_limits':
        return facets.off_limits;
    }
  };

  return (
    <aside className="rc-facets" aria-label="Filters">
      <div className="rc-facets__hd">
        <h2>Filters</h2>
        <button type="button" className="rc-facets__rst" onClick={onReset}>
          Reset
        </button>
      </div>

      <details className="rc-facet" open>
        <summary>
          Relationship
          {selected.relationship.length > 0 ? (
            <span className="rc-facet__badge">{selected.relationship.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {RELATIONSHIP_ORDER.map((value) => {
            const count = bucketCount(facets?.relationship, value);
            if (count === 0 && !selected.relationship.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.relationship.includes(value)}
                  onChange={() => onToggleRelationship(value)}
                />
                {RELATIONSHIP_LABELS[value] ?? value}
                <span className="rc-fopt__ct num">{count}</span>
              </label>
            );
          })}
        </div>
      </details>

      <details className="rc-facet" open>
        <summary>
          Tier
          {selected.tier.length > 0 ? (
            <span className="rc-facet__badge">{selected.tier.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {TIER_ORDER.map((value) => {
            const count = bucketCount(facets?.tier, value);
            if (count === 0 && !selected.tier.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.tier.includes(value)}
                  onChange={() => onToggleTier(value)}
                />
                {TIER_LABELS[value] ?? value}
                <span className="rc-fopt__ct num">{count}</span>
              </label>
            );
          })}
          {facets !== null && facets.tier.length === 0 ? (
            <p className="rc-facet__note">No tiers set on these accounts.</p>
          ) : null}
        </div>
      </details>

      <details className="rc-facet" open>
        <summary>
          Flags
          {selected.flags.length > 0 ? (
            <span className="rc-facet__badge">{selected.flags.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {FLAG_OPTIONS.map((f) => (
            <label key={f.value} className="rc-fopt">
              <input
                type="checkbox"
                checked={selected.flags.includes(f.value)}
                onChange={() => onToggleFlag(f.value)}
              />
              {f.label}
              <span className="rc-fopt__ct num">{flagCount(f.value)}</span>
            </label>
          ))}
        </div>
      </details>

      <details className="rc-facet">
        <summary>
          Industry
          {selected.industry.length > 0 ? (
            <span className="rc-facet__badge">{selected.industry.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {facets === null || facets.industry.length === 0 ? (
            <p className="rc-facet__note">No industry recorded.</p>
          ) : (
            facets.industry.map((b) => (
              <label key={b.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.industry.includes(b.value)}
                  onChange={() => onToggleIndustry(b.value)}
                />
                {b.value}
                <span className="rc-fopt__ct num">{b.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      <p className="rc-facet__loadednote">
        Counts are server-computed across your visible accounts.
      </p>
    </aside>
  );
}
