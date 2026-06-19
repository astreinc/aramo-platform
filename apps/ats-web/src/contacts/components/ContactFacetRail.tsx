import { Icons } from '../../ui';
import {
  PREFERENCE_LABELS,
  PREFERENCE_ORDER,
  ROLE_LABELS,
  ROLE_ORDER,
  type ContactFacets,
  type FacetFlag,
  type FacetState,
} from '../contact-workspace';

// ContactFacetRail — the left filter sidebar (mirrors CompanyFacetRail's
// rc-facet / rc-fopt grammar). COUNTS are SERVER-COMPUTED over the base (scope)
// set — stable as selections toggle. Groups: Relationship role · Communication ·
// Flags · Company. (No Department group — no backing field; no "primary" flag —
// no backing field.)

const FLAG_OPTIONS: readonly { value: FacetFlag; label: string }[] = [
  { value: 'hot', label: 'Hot only' },
  { value: 'quiet', label: 'Going quiet 14d+' },
  { value: 'former', label: 'Former contacts' },
];

interface ContactFacetRailProps {
  readonly facets: ContactFacets | null;
  readonly selected: FacetState;
  /** company_id → display name, resolved from the loaded page. */
  readonly companyNames: Record<string, string>;
  readonly onToggleRole: (value: string) => void;
  readonly onTogglePreference: (value: string) => void;
  readonly onToggleCompany: (value: string) => void;
  readonly onToggleFlag: (value: FacetFlag) => void;
  readonly onReset: () => void;
}

export function ContactFacetRail({
  facets,
  selected,
  companyNames,
  onToggleRole,
  onTogglePreference,
  onToggleCompany,
  onToggleFlag,
  onReset,
}: ContactFacetRailProps) {
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
      case 'former':
        return facets.former;
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
          Relationship role
          {selected.role.length > 0 ? (
            <span className="rc-facet__badge">{selected.role.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {ROLE_ORDER.map((value) => {
            const count = bucketCount(facets?.relationship_role, value);
            if (count === 0 && !selected.role.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.role.includes(value)}
                  onChange={() => onToggleRole(value)}
                />
                {ROLE_LABELS[value] ?? value}
                <span className="rc-fopt__ct num">{count}</span>
              </label>
            );
          })}
          {facets !== null && facets.relationship_role.length === 0 ? (
            <p className="rc-facet__note">No roles classified yet.</p>
          ) : null}
        </div>
      </details>

      <details className="rc-facet" open>
        <summary>
          Communication
          {selected.preference.length > 0 ? (
            <span className="rc-facet__badge">{selected.preference.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {PREFERENCE_ORDER.map((value) => {
            const count = bucketCount(facets?.preference, value);
            if (count === 0 && !selected.preference.includes(value)) return null;
            return (
              <label key={value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.preference.includes(value)}
                  onChange={() => onTogglePreference(value)}
                />
                {PREFERENCE_LABELS[value] ?? value}
                <span className="rc-fopt__ct num">{count}</span>
              </label>
            );
          })}
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
          Company
          {selected.company.length > 0 ? (
            <span className="rc-facet__badge">{selected.company.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {facets === null || facets.company.length === 0 ? (
            <p className="rc-facet__note">No companies on this page.</p>
          ) : (
            facets.company.map((b) => (
              <label key={b.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={selected.company.includes(b.value)}
                  onChange={() => onToggleCompany(b.value)}
                />
                {companyNames[b.value] ?? 'Company'}
                <span className="rc-fopt__ct num">{b.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      <p className="rc-facet__loadednote">
        Counts are server-computed across your visible contacts.
      </p>
    </aside>
  );
}
