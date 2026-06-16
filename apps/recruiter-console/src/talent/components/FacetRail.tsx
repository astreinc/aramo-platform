import { Icons } from '../../ui';
import type {
  CrossFacets,
  FacetBucket,
  NativeFacets,
} from '../types';
import {
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  CONSENT_LABELS,
  STAGE_LABELS,
  RECENCY_OPTIONS,
  type FacetCount,
  type FacetState,
  type SkillMatch,
} from '../talent-workspace';

// FacetRail — the left filter sidebar. SEGMENT 4d: facet COUNTS are now full-set
// from the server (4a native: availability/engagement/source/hot · 4b cross-
// schema: recency/consent/stage) — the "within loaded" qualifier is gone from
// all of them. The ONE exception is Skills: its FILTER is full-set on the server
// but its COUNTS are still within the loaded page (full counts arrive with
// Skills Taxonomy), so the Skills note keeps the honest qualifier.
//
// The native facets (skills/source/hot/location/availability/engagement) are
// interactive server filters. The cross-schema facets (recency/consent/stage)
// are read-only full-set count displays — they have no native filter param, so
// recency filtering is via the Views presets, not a checkbox here. When the BE
// signals over_guard, the cross-schema counts are replaced by the honest
// "narrow your filters" message (never a silent empty state).

interface FacetRailProps {
  readonly facets: FacetState;
  readonly skillCounts: readonly FacetCount[];
  readonly serverFacets: NativeFacets | null;
  readonly crossFacets: CrossFacets | null;
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

// Render the server buckets plus any selected value that has dropped out of the
// current result set (shown with count 0 so it stays unselectable-from).
function bucketsWithSelected(
  buckets: readonly FacetBucket[],
  selected: readonly string[],
): FacetBucket[] {
  const out = [...buckets];
  const present = new Set(buckets.map((b) => b.value));
  for (const v of selected)
    if (!present.has(v)) out.push({ value: v, count: 0 });
  return out;
}

export function FacetRail({
  facets,
  skillCounts,
  serverFacets,
  crossFacets,
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
  const availability = bucketsWithSelected(
    serverFacets?.availability ?? [],
    facets.availability,
  );
  const engagement = bucketsWithSelected(
    serverFacets?.engagement ?? [],
    facets.engagementTypes,
  );
  const sources = bucketsWithSelected(serverFacets?.source ?? [], facets.sources);

  return (
    <aside className="rc-facets" aria-label="Filters">
      <div className="rc-facets__hd">
        <h2>Filters</h2>
        <button type="button" className="rc-facets__rst" onClick={onReset}>
          Reset
        </button>
      </div>

      {/* Skills — server FILTER, within-loaded COUNTS (Skills Taxonomy carry) */}
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
          {skillCounts.length === 0 ? (
            <p className="rc-facet__note">No skills in the loaded set.</p>
          ) : (
            skillCounts.slice(0, 12).map((s) => (
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
          <p className="rc-facet__note">
            Skill counts are within the {loadedCount} loaded talent (the filter
            itself is full-set). Full counts arrive with Skills Taxonomy.
          </p>
        </div>
      </details>

      {/* Hot — server FILTER + full-set COUNT */}
      <details className="rc-facet" open>
        <summary>
          Hot
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          <label className="rc-fopt">
            <input type="checkbox" checked={facets.hotOnly} onChange={onToggleHot} />
            Hot talent only
            <span className="rc-fopt__ct num">{serverFacets?.hot ?? 0}</span>
          </label>
        </div>
      </details>

      {/* Source — server FILTER + full-set COUNT */}
      <details className="rc-facet" open>
        <summary>
          Source
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {sources.length === 0 ? (
            <p className="rc-facet__note">No source recorded.</p>
          ) : (
            sources.map((s) => (
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

      {/* Location — server FILTER (city/state ILIKE); free text has no count */}
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
          <p className="rc-facet__note">Matches city &amp; state, full-set.</p>
        </div>
      </details>

      {/* Availability — server FILTER + full-set COUNT (Unknown = null+'unknown') */}
      <details className="rc-facet" open>
        <summary>
          Availability
          {facets.availability.length > 0 ? (
            <span className="rc-facet__badge">{facets.availability.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {availability.length === 0 ? (
            <p className="rc-facet__note">No availability stated.</p>
          ) : (
            availability.map((a) => (
              <label key={a.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.availability.includes(a.value)}
                  onChange={() => onToggleAvailability(a.value)}
                />
                {AVAILABILITY_LABELS[a.value as keyof typeof AVAILABILITY_LABELS] ??
                  a.value}
                <span className="rc-fopt__ct num">{a.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* Engagement type — server FILTER + full-set COUNT */}
      <details className="rc-facet">
        <summary>
          Engagement type
          {facets.engagementTypes.length > 0 ? (
            <span className="rc-facet__badge">{facets.engagementTypes.length}</span>
          ) : null}
          <Icons.IconChevronDown className="rc-facet__chev" />
        </summary>
        <div className="rc-facet__body">
          {engagement.length === 0 ? (
            <p className="rc-facet__note">No engagement type stated.</p>
          ) : (
            engagement.map((e) => (
              <label key={e.value} className="rc-fopt">
                <input
                  type="checkbox"
                  checked={facets.engagementTypes.includes(e.value)}
                  onChange={() => onToggleEngagement(e.value)}
                />
                {ENGAGEMENT_LABELS[e.value as keyof typeof ENGAGEMENT_LABELS] ??
                  e.value}
                <span className="rc-fopt__ct num">{e.count}</span>
              </label>
            ))
          )}
        </div>
      </details>

      {/* Cross-schema facets — full-set COUNTS (read-only; recency filtering is
          via the Views presets). over_guard ⇒ the honest narrow message. */}
      <CrossFacetSection crossFacets={crossFacets} />

      {/* STUB — Rate is talent-stated free text; never an ordering (R10). */}
      <StubFacet
        label="Rate (talent-stated)"
        note="Rate is what the talent stated. Aramo never infers pay or orders results by it. (Free text — no range filter.)"
      />

      {isLead ? (
        <div className="rc-facets__lead">
          <StubFacet
            label="Lead views"
            note="Unassigned / going-stale / not-in-req / cool-off need bulk reads (carry)."
            open
          />
        </div>
      ) : null}
    </aside>
  );
}

function CrossFacetSection({
  crossFacets,
}: {
  readonly crossFacets: CrossFacets | null;
}) {
  const guardMessage =
    'Too many talent to count by last activity, consent or stage across the ' +
    'full set. Narrow your filters, then these counts return.';

  const recency =
    crossFacets === null
      ? []
      : RECENCY_OPTIONS.map((o) => ({
          value: o.key,
          label: o.label,
          count: crossFacets.recency[o.key] ?? 0,
        }));

  return (
    <details className="rc-facet" open>
      <summary>
        Activity, consent &amp; stage
        <Icons.IconChevronDown className="rc-facet__chev" />
      </summary>
      <div className="rc-facet__body">
        {crossFacets !== null && crossFacets.over_guard ? (
          <p className="rc-facet__guard" role="status">
            {guardMessage}
          </p>
        ) : (
          <>
            <p className="rc-facet__sub">Last activity</p>
            {recency.map((r) => (
              <div key={r.value} className="rc-fopt rc-fopt--readonly">
                {r.label}
                <span className="rc-fopt__ct num">{r.count}</span>
              </div>
            ))}
            <p className="rc-facet__sub">Consent</p>
            {(crossFacets?.consent ?? []).length === 0 ? (
              <p className="rc-facet__note">No consent summary.</p>
            ) : (
              (crossFacets?.consent ?? []).map((c) => (
                <div key={c.value} className="rc-fopt rc-fopt--readonly">
                  {CONSENT_LABELS[c.value] ?? c.value}
                  <span className="rc-fopt__ct num">{c.count}</span>
                </div>
              ))
            )}
            <p className="rc-facet__sub">Pipeline stage</p>
            {(crossFacets?.stage ?? []).filter((s) => s.value !== 'none').length ===
            0 ? (
              <p className="rc-facet__note">No active pipeline stages.</p>
            ) : (
              (crossFacets?.stage ?? [])
                .filter((s) => s.value !== 'none')
                .map((s) => (
                  <div key={s.value} className="rc-fopt rc-fopt--readonly">
                    {STAGE_LABELS[s.value as keyof typeof STAGE_LABELS] ?? s.value}
                    <span className="rc-fopt__ct num">{s.count}</span>
                  </div>
                ))
            )}
            <p className="rc-facet__note">
              Full-set counts. Filter by recency with the Views presets above.
            </p>
          </>
        )}
      </div>
    </details>
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
