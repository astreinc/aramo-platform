import { Icons } from '../../ui';
import type { CompanyView } from '../types';
import {
  RELATIONSHIP_LABELS,
  TIER_LABELS,
  countWhere,
  isQuiet,
  type FacetFlag,
  type FacetState,
} from '../company-workspace';

// CompanyFacetRail — the left filter sidebar for the companies workspace
// (mirrors the talent FacetRail grammar: rc-facet / rc-fopt). All COUNTS are
// client-side over the scoped (pre-facet) loaded set — honest given the 50-cap
// banner. Groups: Relationship · Tier · Industry · Flags. No health/risk group
// (not a backend field).

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
  /** The scoped (My/All) set BEFORE facets — the basis for option counts. */
  readonly companies: readonly CompanyView[];
  readonly industries: readonly string[];
  readonly facets: FacetState;
  readonly onToggleRelationship: (value: string) => void;
  readonly onToggleTier: (value: string) => void;
  readonly onToggleIndustry: (value: string) => void;
  readonly onToggleFlag: (value: FacetFlag) => void;
  readonly onReset: () => void;
}

export function CompanyFacetRail({
  companies,
  industries,
  facets,
  onToggleRelationship,
  onToggleTier,
  onToggleIndustry,
  onToggleFlag,
  onReset,
}: CompanyFacetRailProps) {
  const flagCount = (flag: FacetFlag): number => {
    switch (flag) {
      case 'hot':
        return countWhere(companies, (c) => c.is_hot);
      case 'quiet':
        return countWhere(companies, (c) => isQuiet(c));
      case 'exclusive':
        return countWhere(companies, (c) => c.exclusivity);
      case 'off_limits':
        return countWhere(companies, (c) => c.off_limits);
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
          {facets.relationship.length > 0 ? (
            <span className="rc-facet__badge">{facets.relationship.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {RELATIONSHIP_ORDER.map((value) => {
            const count = countWhere(companies, (c) => c.status === value);
            if (count === 0 && !facets.relationship.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.relationship.includes(value)}
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
          {facets.tier.length > 0 ? (
            <span className="rc-facet__badge">{facets.tier.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {TIER_ORDER.map((value) => {
            const count = countWhere(companies, (c) => c.client_tier === value);
            if (count === 0 && !facets.tier.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.tier.includes(value)}
                  onChange={() => onToggleTier(value)}
                />
                {TIER_LABELS[value] ?? value}
                <span className="rc-fopt__ct num">{count}</span>
              </label>
            );
          })}
          {TIER_ORDER.every(
            (v) => countWhere(companies, (c) => c.client_tier === v) === 0,
          ) ? (
            <p className="rc-facet__note">No tiers set on these accounts.</p>
          ) : null}
        </div>
      </details>

      <details className="rc-facet" open>
        <summary>
          Flags
          {facets.flags.length > 0 ? (
            <span className="rc-facet__badge">{facets.flags.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {FLAG_OPTIONS.map((f) => (
            <label key={f.value} className="rc-fopt">
              <input
                type="checkbox"
                checked={facets.flags.includes(f.value)}
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
          {facets.industry.length > 0 ? (
            <span className="rc-facet__badge">{facets.industry.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {industries.length === 0 ? (
            <p className="rc-facet__note">No industry recorded.</p>
          ) : (
            industries.map((value) => (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.industry.includes(value)}
                  onChange={() => onToggleIndustry(value)}
                />
                {value}
                <span className="rc-fopt__ct num">
                  {countWhere(companies, (c) => c.industry === value)}
                </span>
              </label>
            ))
          )}
        </div>
      </details>

      <p className="rc-facet__loadednote">
        Counts are within the loaded accounts (the list is capped at 50). Cursor
        pagination and server-side facets are on the roadmap.
      </p>
    </aside>
  );
}
