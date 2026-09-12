import { useRef, useState } from 'react';

import { Icons } from '../../ui';
import { useDetailsAutoClose } from '../use-details-auto-close';
import type { CrossFacets, FacetBucket, NativeFacets } from '../types';
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

// FilterBar — the horizontal filter-pill bar (prototype parity), replacing the
// left FacetRail sidebar. Same server-backed filters + full-set counts; each
// pill is a rc-hmenu <details> dropdown (the proven Columns/Sort pattern). The
// native facets (skills/source/hot/location/availability/engagement) are
// interactive server filters; Activity/consent/stage are READ-ONLY full-set
// counts (cross-schema — no native filter param; recency filtering is via the
// Views presets, stage/consent filtering is a follow-up). MODE: no faked wiring.

interface FilterBarProps {
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
}

// Render the server buckets plus any selected value that has dropped out of the
// current result set (shown with count 0 so it stays unselectable-from).
function bucketsWithSelected(
  buckets: readonly FacetBucket[],
  selected: readonly string[],
): FacetBucket[] {
  const out = [...buckets];
  const present = new Set(buckets.map((b) => b.value));
  for (const v of selected) if (!present.has(v)) out.push({ value: v, count: 0 });
  return out;
}

// One filter pill = a rc-hmenu <details> with a pill-styled summary.
function Pill({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count?: number;
  readonly children: React.ReactNode;
}) {
  const active = count !== undefined && count > 0;
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsAutoClose(ref);
  return (
    <details ref={ref} className={`rc-hmenu rc-fpill${active ? ' rc-fpill--active' : ''}`}>
      <summary>
        {label}
        {active ? <span className="rc-fpill__ct num">{count}</span> : null}
        <Icons.IconChevronDown className="rc-fpill__chev" />
      </summary>
      <div className="rc-hmenu__body">{children}</div>
    </details>
  );
}

function DoneRow() {
  return (
    <button
      type="button"
      className="rc-fpop__done"
      onClick={(e) => e.currentTarget.closest('details')?.removeAttribute('open')}
    >
      Done
    </button>
  );
}

export function FilterBar({
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
}: FilterBarProps) {
  const [skillQuery, setSkillQuery] = useState('');
  const availability = bucketsWithSelected(
    serverFacets?.availability ?? [],
    facets.availability,
  );
  const engagement = bucketsWithSelected(
    serverFacets?.engagement ?? [],
    facets.engagementTypes,
  );
  const sources = bucketsWithSelected(serverFacets?.source ?? [], facets.sources);
  const q = skillQuery.trim().toLowerCase();
  const skills = skillCounts.filter(
    (s) => facets.skills.includes(s.value) || q === '' || s.value.toLowerCase().includes(q),
  );

  return (
    <div className="rc-fbar" role="group" aria-label="Filters">
      {/* Skills — server FILTER, within-loaded COUNTS (Skills Taxonomy carry) */}
      <Pill label="Skills" count={facets.skills.length}>
        <div className="rc-fpop__search">
          <Icons.IconSearch />
          <input
            type="text"
            value={skillQuery}
            placeholder="Type a skill"
            aria-label="Filter skills list"
            onChange={(e) => setSkillQuery(e.target.value)}
          />
        </div>
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
        {skills.length === 0 ? (
          <p className="rc-facet__note">No skills in the loaded set.</p>
        ) : (
          skills.slice(0, 12).map((s) => (
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
          Skill counts are within the {loadedCount} loaded talent (the filter itself
          is full-set). Full counts arrive with Skills Taxonomy.
        </p>
        <DoneRow />
      </Pill>

      {/* Availability — server FILTER + full-set COUNT */}
      <Pill label="Availability" count={facets.availability.length}>
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
              {AVAILABILITY_LABELS[a.value as keyof typeof AVAILABILITY_LABELS] ?? a.value}
              <span className="rc-fopt__ct num">{a.count}</span>
            </label>
          ))
        )}
        <DoneRow />
      </Pill>

      {/* Source — server FILTER + full-set COUNT */}
      <Pill label="Source" count={facets.sources.length}>
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
        <DoneRow />
      </Pill>

      {/* Engagement type — server FILTER + full-set COUNT */}
      <Pill label="Engagement type" count={facets.engagementTypes.length}>
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
              {ENGAGEMENT_LABELS[e.value as keyof typeof ENGAGEMENT_LABELS] ?? e.value}
              <span className="rc-fopt__ct num">{e.count}</span>
            </label>
          ))
        )}
        <DoneRow />
      </Pill>

      {/* Location — server FILTER (city/state ILIKE); free text, no count */}
      <Pill label="Location" count={facets.location.trim() !== '' ? 1 : 0}>
        <input
          type="text"
          className="rc-facet__input"
          placeholder="City or state"
          value={facets.location}
          onChange={(e) => onLocation(e.target.value)}
          aria-label="Filter by location"
        />
        <p className="rc-facet__note">Matches city &amp; state, full-set.</p>
        <DoneRow />
      </Pill>

      {/* Hot — server FILTER + full-set COUNT */}
      <Pill label="Hot" count={facets.hotOnly ? 1 : 0}>
        <label className="rc-fopt">
          <input type="checkbox" checked={facets.hotOnly} onChange={onToggleHot} />
          Hot talent only
          <span className="rc-fopt__ct num">{serverFacets?.hot ?? 0}</span>
        </label>
        <DoneRow />
      </Pill>

      {/* Activity, consent & stage — READ-ONLY full-set counts (cross-schema;
          recency filtering is via the Views presets; stage/consent filtering is
          a follow-up). over_guard ⇒ the honest narrow message. */}
      <Pill label="Activity &amp; consent">
        <CrossFacetCounts crossFacets={crossFacets} />
        <DoneRow />
      </Pill>

      <button type="button" className="rc-fbar__reset" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}

function CrossFacetCounts({ crossFacets }: { readonly crossFacets: CrossFacets | null }) {
  const guardMessage =
    'Too many talent to count by last activity, consent or stage across the ' +
    'full set. Narrow your filters, then these counts return.';

  if (crossFacets !== null && crossFacets.over_guard) {
    return (
      <p className="rc-facet__guard" role="status">
        {guardMessage}
      </p>
    );
  }

  const recency =
    crossFacets === null
      ? []
      : RECENCY_OPTIONS.map((o) => ({
          value: o.key,
          label: o.label,
          count: crossFacets.recency[o.key] ?? 0,
        }));

  return (
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
      {(crossFacets?.stage ?? []).filter((s) => s.value !== 'none').length === 0 ? (
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
  );
}
