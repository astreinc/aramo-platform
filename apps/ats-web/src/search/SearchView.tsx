import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FormField,
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import type { CompanyView, ContactView } from '../companies/types';
import type { RequisitionView } from '../requisitions/types';
import type { TalentRecordView } from '../talent/types';

import {
  searchCompanies,
  searchContacts,
  searchRequisitions,
  searchTalent,
  searchTalentByResume,
} from './search-api';
import { sectionErrorMessage } from './error-messages';

// Search FE /search — the cross-entity quick-search surface consuming the
// Search PR-1 (PR#221) per-entity ?q= primitive.
//
// THE RULINGS (Gate-5):
//   R-CONTACTS — Contacts has NO recruiter detail view/route, so contact
//     rows are NON-LINKING display rows (name + company/title context). A
//     contact detail surface is a filed carry.
//   R-NAV — the nav entry is always-visible (no requireScope); THIS view
//     does the per-section scope-gating (and shows "no searchable entities"
//     if the actor holds zero search scopes).
//   R-ROW — simple local link-rows (the foundation list views are full
//     Table surfaces, not drop-in rows; these rows are LOCAL,
//     promote-on-2nd-consumer).
//
// THE POSTURE: fan out IN PARALLEL (Promise.allSettled) over a flat list of
// CALLS to ONLY the endpoints whose search scope the actor holds — never fire
// a call that 403s. Visibility is server-side (the ?q= / ?resume_q= results
// ARE the visibility-scoped truth): NO client-side filtering, NO truncation
// banner. One call erroring does not kill the others (allSettled isolation).
//
// SEARCH PR-2 WIRING (Ruling 1) — the Talent section fires TWO calls: the
// PR-1 name ?q= AND the PR-2 résumé ?resume_q=, as SEPARATE entries in the
// fan-out (NOT ?q=&?resume_q= together — the BE ANDs those → near-empty).
// The two talent results MERGE + DEDUPE by talent id (a talent matching by
// name OR résumé appears once); a résumé-match carries its `resume_snippet`
// excerpt (Ruling 2). allSettled isolation holds PER CALL (Ruling 4): if the
// name call errors but the résumé call succeeds (or vice versa), the Talent
// section still renders the surviving call's rows — it errors only if BOTH
// talent calls fail.

const DEBOUNCE_MS = 300;

interface ResultRow {
  readonly key: string;
  readonly primary: string;
  readonly secondary: string | null;
  // Absent → a non-linking display row (R-CONTACTS).
  readonly to?: string;
  // Search PR-2 (Ruling 2) — set on a résumé-content match; rendered inline
  // as "Matched in résumé: …". Absent on name-only matches.
  readonly snippet?: string | null;
}

interface SectionConfig {
  readonly key: string;
  readonly label: string;
  readonly scope: string;
  // One or more fan-out calls feeding this section. Talent has TWO (name +
  // résumé, Ruling 1); the other entities have one. The section's rows are
  // the merged+deduped union of its calls' fulfilled results.
  readonly runs: ReadonlyArray<(q: string) => Promise<readonly ResultRow[]>>;
}

function personName(first: string, last: string): string {
  const name = `${first.trim()} ${last.trim()}`.trim();
  return name === '' ? '—' : name;
}

function talentRow(t: TalentRecordView): ResultRow {
  return {
    key: t.id,
    primary: personName(t.first_name, t.last_name),
    secondary: t.current_employer ?? t.email1 ?? null,
    to: `/talent/${t.id}`,
  };
}

// Search PR-2 — a résumé-content match row. Same talent row, plus the
// `resume_snippet` excerpt (Ruling 2). The <mark> markers ts_headline emits
// are stripped to plain text (rendered as text, not HTML — no XSS surface
// from résumé-derived content).
function talentResumeRow(t: TalentRecordView): ResultRow {
  const raw = t.resume_snippet ?? null;
  return {
    ...talentRow(t),
    snippet: raw === null ? null : raw.replace(/<\/?mark>/g, ''),
  };
}

// Merge + dedupe rows by key (Ruling 1). First occurrence wins for the base
// row (name call is ordered first → keeps its `to`/secondary); a later
// occurrence carrying a snippet UPGRADES the kept row so a name+résumé match
// shows ONCE, with its résumé snippet.
function dedupeRows(rows: readonly ResultRow[]): ResultRow[] {
  const byKey = new Map<string, ResultRow>();
  for (const row of rows) {
    const existing = byKey.get(row.key);
    if (existing === undefined) {
      byKey.set(row.key, row);
    } else if (
      (existing.snippet ?? null) === null &&
      (row.snippet ?? null) !== null
    ) {
      byKey.set(row.key, { ...existing, snippet: row.snippet });
    }
  }
  return [...byKey.values()];
}

function companyRow(c: CompanyView): ResultRow {
  return { key: c.id, primary: c.name, secondary: null, to: `/companies/${c.id}` };
}

function requisitionRow(r: RequisitionView): ResultRow {
  return { key: r.id, primary: r.title, secondary: null, to: `/requisitions/${r.id}` };
}

function contactRow(c: ContactView): ResultRow {
  // R-CONTACTS — NO `to`: contacts have no recruiter detail view. Display
  // the name + the title context; non-linking.
  return {
    key: c.id,
    primary: personName(c.first_name, c.last_name),
    secondary: c.title ?? c.email1 ?? null,
    // to: intentionally absent — non-linking display row.
  };
}

// The 4 searchable entities. Order = the recruiter's mental model
// (Talent / Companies / Requisitions / Contacts). Each section is queried
// + shown ONLY if the actor holds its scope (R-NAV / R2 per-entity parity).
const SECTIONS: readonly SectionConfig[] = [
  {
    key: 'talent',
    label: 'Talent',
    scope: 'talent:search',
    // Ruling 1 — TWO calls: name ?q= AND résumé ?resume_q= (merged + deduped).
    runs: [
      (q) => searchTalent(q).then((r) => r.items.map(talentRow)),
      (q) => searchTalentByResume(q).then((r) => r.items.map(talentResumeRow)),
    ],
  },
  {
    key: 'companies',
    label: 'Companies',
    scope: 'company:search',
    runs: [(q) => searchCompanies(q).then((r) => r.items.map(companyRow))],
  },
  {
    key: 'requisitions',
    label: 'Requisitions',
    scope: 'requisition:search',
    runs: [
      (q) => searchRequisitions(q).then((r) => r.items.map(requisitionRow)),
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    scope: 'contact:search',
    runs: [(q) => searchContacts(q).then((r) => r.items.map(contactRow))],
  },
];

type SectionStatus = 'loading' | 'ready' | 'error';

interface SectionState {
  readonly status: SectionStatus;
  readonly rows: readonly ResultRow[];
  readonly error: string | null;
}

interface SearchViewProps {
  // Test seam (R5 precedent) — a fixed session so the per-section scope
  // gate is exercisable without mounting the real session hook.
  readonly sessionOverride?: Session;
}

export function SearchView({ sessionOverride }: SearchViewProps = {}) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  // The sections the actor can search (per-section scope gate). Defensive
  // (R4 LIST precedent): guard a malformed session shape.
  const allowedSections = useMemo<readonly SectionConfig[]>(() => {
    if (session === null || !Array.isArray(session.scopes)) return [];
    return SECTIONS.filter((s) => hasScope(session, s.scope));
  }, [session]);

  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [sections, setSections] = useState<Record<string, SectionState>>({});

  // Debounce the input → submitted query.
  useEffect(() => {
    const trimmed = query.trim();
    const handle = setTimeout(() => setSubmitted(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Fan out on the debounced query. Empty query → no fan-out (cleared).
  useEffect(() => {
    if (submitted === '') {
      setSections({});
      return;
    }
    let cancelled = false;
    setSections(
      Object.fromEntries(
        allowedSections.map((s) => [
          s.key,
          { status: 'loading', rows: [], error: null } as SectionState,
        ]),
      ),
    );
    // Flatten to a list of CALLS (Talent contributes two — Ruling 1), each
    // tagged with its section, so the fan-out isolates PER CALL (Ruling 4).
    const calls = allowedSections.flatMap((s) =>
      s.runs.map((run) => ({ sectionKey: s.key, label: s.label, run })),
    );
    void Promise.allSettled(calls.map((c) => c.run(submitted))).then(
      (results) => {
        if (cancelled) return;
        setSections(
          Object.fromEntries(
            allowedSections.map((s) => {
              // The call results belonging to this section.
              const own = calls
                .map((c, i) => ({ c, res: results[i] }))
                .filter((x) => x.c.sectionKey === s.key);
              const fulfilled = own.filter(
                (x) => x.res !== undefined && x.res.status === 'fulfilled',
              );
              // Ruling 4 — the section errors ONLY if ALL its calls failed;
              // a partial success renders the surviving call's rows.
              if (fulfilled.length === 0) {
                const firstRejected = own.find(
                  (x) => x.res !== undefined && x.res.status === 'rejected',
                );
                return [
                  s.key,
                  {
                    status: 'error',
                    rows: [],
                    error: sectionErrorMessage(
                      s.label,
                      firstRejected !== undefined &&
                        firstRejected.res !== undefined &&
                        firstRejected.res.status === 'rejected'
                        ? firstRejected.res.reason
                        : undefined,
                    ),
                  } as SectionState,
                ];
              }
              const merged = dedupeRows(
                fulfilled.flatMap((x) =>
                  x.res !== undefined && x.res.status === 'fulfilled'
                    ? x.res.value
                    : [],
                ),
              );
              return [
                s.key,
                { status: 'ready', rows: merged, error: null } as SectionState,
              ];
            }),
          ),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [submitted, allowedSections]);

  return (
    <section>
      <PageHeader
        title="Search"
        description="Quick-search across the records you can see. Results respect your visibility."
      />

      {allowedSections.length === 0 ? (
        <p role="status" data-testid="search-no-access">
          You don’t have access to search any records.
        </p>
      ) : (
        <>
          <FormField label="Search">
            <input
              id="search-input"
              type="search"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search talent, companies, requisitions, contacts…"
              autoComplete="off"
            />
          </FormField>

          {submitted === '' ? (
            <p data-testid="search-prompt">Type to search.</p>
          ) : (
            allowedSections.map((s) => (
              <SearchSection
                key={s.key}
                label={s.label}
                state={
                  sections[s.key] ?? { status: 'loading', rows: [], error: null }
                }
              />
            ))
          )}
        </>
      )}
    </section>
  );
}

function SearchSection({
  label,
  state,
}: {
  readonly label: string;
  readonly state: SectionState;
}) {
  return (
    <section className="search-section" aria-label={label}>
      <h2 className="search-section__title">{label}</h2>
      {state.status === 'loading' ? (
        <p>Searching {label.toLowerCase()}…</p>
      ) : state.status === 'error' ? (
        <InlineAlert variant="error">{state.error}</InlineAlert>
      ) : state.rows.length === 0 ? (
        <p className="search-section__empty">No matching {label.toLowerCase()}.</p>
      ) : (
        <ul className="search-section__rows">
          {state.rows.map((row) => (
            <li key={row.key} className="search-section__row">
              {row.to !== undefined ? (
                <Link to={row.to}>{row.primary}</Link>
              ) : (
                // R-CONTACTS — non-linking display row.
                <span>{row.primary}</span>
              )}
              {row.secondary !== null ? (
                <span className="search-section__secondary"> — {row.secondary}</span>
              ) : null}
              {row.snippet != null && row.snippet !== '' ? (
                // Search PR-2 (Ruling 2) — résumé-content match excerpt.
                <span className="search-section__snippet" data-testid="resume-snippet">
                  {' '}· Matched in résumé: {row.snippet}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
