import { Icons } from '../../ui';
import {
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  type DerivedFacets,
  type FacetState,
  type SkillMatch,
} from '../talent-workspace';

// FacetRail — the left filter sidebar for the Talent workspace. Feature-local
// (first use; promote to ui/ on the third faceted surface per rule-of-three).
//
// BACKABLE facets (client-side over the loaded page; counts are "within loaded",
// never fabricated): Skills (key_skills, match any/all), Source, Location (free
// text over city/state), Hot. STUB facets render disabled with a one-line carry
// note — the talent record has no status / availability / numeric-rate /
// engagement-type / last-activity / per-row consent fields (audited).

interface FacetRailProps {
  readonly derived: DerivedFacets;
  readonly facets: FacetState;
  readonly loadedCount: number;
  readonly onToggleSkill: (skill: string) => void;
  readonly onSkillMatch: (m: SkillMatch) => void;
  readonly onToggleSource: (source: string) => void;
  readonly onToggleHot: () => void;
  readonly onLocation: (v: string) => void;
  readonly onToggleAvailability: (value: string) => void;
  readonly onToggleEngagement: (value: string) => void;
  readonly onReset: () => void;
  readonly isLead: boolean;
}

export function FacetRail({
  derived,
  facets,
  loadedCount,
  onToggleSkill,
  onSkillMatch,
  onToggleSource,
  onToggleHot,
  onLocation,
  onToggleAvailability,
  onToggleEngagement,
  onReset,
  isLead,
}: FacetRailProps) {
  return (
    <aside className="rc-facets" aria-label="Filters">
      <div className="rc-facets__hd">
        <h2>Filters</h2>
        <button type="button" className="rc-facets__rst" onClick={onReset}>
          Reset
        </button>
      </div>

      {/* Skills — BACKED (key_skills, counts within loaded set) */}
      <details className="rc-facet" open>
        <summary>
          Skills
          {facets.skills.length > 0 ? (
            <span className="rc-facet__badge">{facets.skills.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          <div className="rc-seg" role="group" aria-label="Skill match mode">
            <button
              type="button"
              className={facets.skillMatch === 'any' ? 'on' : ''}
              aria-pressed={facets.skillMatch === 'any'}
              onClick={() => onSkillMatch('any')}
            >
              Match any
            </button>
            <button
              type="button"
              className={facets.skillMatch === 'all' ? 'on' : ''}
              aria-pressed={facets.skillMatch === 'all'}
              onClick={() => onSkillMatch('all')}
            >
              Match all
            </button>
          </div>
          {derived.skills.length === 0 ? (
            <p className="rc-facet__note">No skills in the loaded set.</p>
          ) : (
            derived.skills.slice(0, 12).map((s) => (
              <label key={s.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.skills.includes(s.value)}
                  onChange={() => onToggleSkill(s.value)}
                />
                {s.value}
                <span className="rc-fopt__ct num">{s.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* Hot — BACKED (is_hot) */}
      <details className="rc-facet" open>
        <summary>
          Hot
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          <label className="rc-fopt">
            <input type="checkbox" checked={facets.hotOnly} onChange={onToggleHot} />
            Hot talent only
            <span className="rc-fopt__ct num">{derived.hot}</span>
          </label>
        </div>
      </details>

      {/* Source — BACKED (source field) */}
      <details className="rc-facet" open>
        <summary>
          Source
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {derived.sources.length === 0 ? (
            <p className="rc-facet__note">No source recorded in the loaded set.</p>
          ) : (
            derived.sources.map((s) => (
              <label key={s.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.sources.includes(s.value)}
                  onChange={() => onToggleSource(s.value)}
                />
                {s.value}
                <span className="rc-fopt__ct num">{s.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* Location — text over city/state is BACKED; radius + remote-friendly are
          rendered-as-drawn but disabled (no geo / no remote field — carry). */}
      <details className="rc-facet">
        <summary>
          Location
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          <input
            type="text"
            className="rc-facet__input"
            placeholder="City or state"
            value={facets.location}
            onChange={(e) => onLocation(e.target.value)}
            aria-label="Filter by location"
          />
          <select
            className="rc-facet__input rc-mt-8"
            disabled
            aria-label="Search radius (not available yet)"
            title="Radius search needs geocoding — not modelled yet (carry)."
            defaultValue="exact"
          >
            <option value="25">Within 25 mi</option>
            <option value="50">Within 50 mi</option>
            <option value="100">Within 100 mi</option>
            <option value="exact">Exact</option>
          </select>
          <label className="rc-fopt rc-fopt--disabled" title="No remote field on the talent record yet (carry).">
            <input type="checkbox" disabled />
            Include remote-friendly
          </label>
          <p className="rc-facet__note">
            Text matches city &amp; state. Radius &amp; remote-friendly need geo /
            a remote field — carry.
          </p>
        </div>
      </details>

      {/* Availability — BACKED (talent-stated; Unknown bucket = null + 'unknown') */}
      <details className="rc-facet" open>
        <summary>
          Availability
          {facets.availability.length > 0 ? (
            <span className="rc-facet__badge">{facets.availability.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {derived.availability.length === 0 ? (
            <p className="rc-facet__note">No availability stated in the loaded set.</p>
          ) : (
            derived.availability.map((a) => (
              <label key={a.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.availability.includes(a.value)}
                  onChange={() => onToggleAvailability(a.value)}
                />
                {AVAILABILITY_LABELS[a.value as keyof typeof AVAILABILITY_LABELS] ?? a.value}
                <span className="rc-fopt__ct num">{a.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* Engagement type — BACKED (talent-stated; null = not stated) */}
      <details className="rc-facet">
        <summary>
          Engagement type
          {facets.engagementTypes.length > 0 ? (
            <span className="rc-facet__badge">{facets.engagementTypes.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {derived.engagement.length === 0 ? (
            <p className="rc-facet__note">No engagement type stated in the loaded set.</p>
          ) : (
            derived.engagement.map((e) => (
              <label key={e.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.engagementTypes.includes(e.value)}
                  onChange={() => onToggleEngagement(e.value)}
                />
                {ENGAGEMENT_LABELS[e.value as keyof typeof ENGAGEMENT_LABELS] ?? e.value}
                <span className="rc-fopt__ct num">{e.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* STUB facets — fields absent on the talent record (honest disabled) */}
      <StubFacet label="Status & stage" note="Stage is per-pipeline; wired in Segment 3." />
      <StubFacet
        label="Rate (talent-stated)"
        note="Rate is what the talent stated. Aramo never infers pay or orders results by it. (Free text — no range filter.)"
      />
      <StubFacet label="Last activity" note="Needs a bulk last-activity read (carry — per-talent N+1 today)." />
      <StubFacet label="Consent" note="Per-talent consent is an N+1 read keyed to a Core id (carry)." />

      {isLead ? (
        <div className="rc-facets__lead">
          <StubFacet
            label="Lead views"
            note="Unassigned / going-stale / not-in-req / cool-off need bulk reads (carry)."
            open
          />
        </div>
      ) : null}

      <p className="rc-facet__loadednote">
        Facet counts are within the {loadedCount} loaded talent. Server-side
        faceted search is a backend carry.
      </p>
    </aside>
  );
}

function StubFacet({
  label,
  note,
  open,
}: {
  readonly label: string;
  readonly note: string;
  readonly open?: boolean;
}) {
  return (
    <details className="rc-facet rc-facet--stub" open={open}>
      <summary>
        {label}
        <span className="rc-facet__soon">Soon</span>
        <Icons.IconChevronDown className="rc-facet__chev" />
      </summary>
      <div className="rc-facet__body">
        <p className="rc-facet__note">{note}</p>
      </div>
    </details>
  );
}
