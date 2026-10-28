import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import {
  LEGAL_CATALOG,
  MAXMIND_ATTRIBUTION,
  PUBLIC_SIGN_ORIGIN,
  SUBPROCESSORS_PATH,
  SUBPROCESSORS_SLUG,
  SUBPROCESSOR_LISTS,
  THIRD_PARTY_NOTICES_PATH,
  currentLegal,
  currentSubprocessors,
  findLegal,
  formatEffective,
  legalEntryStatus,
  legalPath,
  upcomingSubprocessors,
  type LegalCatalogEntry,
  type SubprocessorList,
} from './catalog';
import { ARAMO_SIGN_IDENTITY, HELP_PATH, LEGAL_INDEX_PATH, TERMS_INDEX_PATH } from './identity';
import { Markdown } from './markdown';
import { LEGAL_TEXTS, type LegalText } from './texts';

/**
 * What the legal pages resolve against: the catalog, the bundled texts, the
 * subprocessor lists and the clock. Production uses the bundled values and the
 * system clock; tests provide fixtures (E-5: upcoming/superseded versions are
 * exercised without registering an unapproved text).
 */
export interface LegalEnv {
  catalog: readonly LegalCatalogEntry[];
  texts: Readonly<Record<string, LegalText>>;
  subprocessors: readonly SubprocessorList[];
  now: () => Date;
}

export const LegalEnvContext = createContext<LegalEnv>({
  catalog: LEGAL_CATALOG,
  texts: LEGAL_TEXTS,
  subprocessors: SUBPROCESSOR_LISTS,
  now: () => new Date(),
});

// Aramo Sign Personal (Free) — the published legal texts on sign.aramo.ai
// (public, no sign-in): /legal/:slug (the version in effect) and
// /legal/:slug/:version (exact; an upcoming or superseded version carries a banner).
// /legal/subprocessors (no version) is the subprocessor list, not a registry text.
// The page shows the bundled text exactly as approved (rendered safely, never as
// HTML); an unknown document or version is a not-found page, never a fallback to
// another version.

export function Shell({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  useEffect(() => {
    document.title = `${title} · Aramo Sign`;
  }, [title]);
  return (
    <div className="sg sg-legal" data-testid={testId}>
      <header className="sg-legal__top">
        <a className="sg-legal__brand" href="/">
          <span className="sg-brand__mark" aria-hidden="true">
            S
          </span>
          Aramo Sign
        </a>
      </header>
      <main className="sg-legal__main">{children}</main>
      <LegalFooter />
    </div>
  );
}

function LegalFooter() {
  const { catalog, now } = useContext(LegalEnvContext);
  const at = now();
  const slugs = [...new Set(catalog.map((d) => d.slug))];
  return (
    <footer className="sg-legal__foot" aria-label="Legal">
      {slugs.map((s) => {
        const d = currentLegal(s, catalog, at);
        if (d === null) return null;
        return (
          <a key={s} href={legalPath(d.slug, d.version, catalog, at)}>
            {d.title}
          </a>
        );
      })}
      <a href={SUBPROCESSORS_PATH}>Subprocessors</a>
      <a href={THIRD_PARTY_NOTICES_PATH}>Third-party notices</a>
      <a href={HELP_PATH}>Help</a>
      <span className="sg-muted" data-testid="legal-footer-identity">
        Aramo Sign is developed and operated by {ARAMO_SIGN_IDENTITY.legalEntity}
      </span>
    </footer>
  );
}

export function LegalNotFound() {
  return (
    <Shell title="Document not found" testId="legal-not-found">
      <h1 className="sg-h1">Document not found</h1>
      <p className="sg-lede">There is no published document at this address. The documents we publish are listed below.</p>
    </Shell>
  );
}

/** The documents in effect now, with a link to each (the order of the catalog). */
function CurrentDocuments({ slugs, testId }: { slugs: readonly string[]; testId: string }) {
  const { catalog, now } = useContext(LegalEnvContext);
  const at = now();
  const docs = slugs.map((s) => currentLegal(s, catalog, at)).filter((d): d is LegalCatalogEntry => d !== null);
  return (
    <ul data-testid={testId}>
      {docs.map((d) => (
        <li key={d.slug}>
          <a href={legalPath(d.slug, d.version, catalog, at)}>{d.title}</a> (version {d.version})
        </li>
      ))}
    </ul>
  );
}

// Aramo-Sign-Mobile-Amendment-M-A7 §5.1 (R-8) — /legal: every published document
// in effect now, plus the subprocessor list and the third-party notices.
export function LegalIndexPage() {
  const { catalog } = useContext(LegalEnvContext);
  const slugs = [...new Set(catalog.map((d) => d.slug))];
  return (
    <Shell title="Legal" testId="legal-index">
      <h1 className="sg-h1">Aramo Sign legal documents</h1>
      <div className="sg-legal__doc">
        <p>The documents we publish, in the version in effect now. Each has a permanent link to that exact version.</p>
        <CurrentDocuments slugs={slugs} testId="legal-index-documents" />
        <p>
          Also: <a href={SUBPROCESSORS_PATH}>subprocessors</a> and <a href={THIRD_PARTY_NOTICES_PATH}>third-party notices</a>. For
          the terms that apply to you, see <a href={TERMS_INDEX_PATH}>Aramo Sign terms</a>.
        </p>
      </div>
    </Shell>
  );
}

// M-A7 §5.1 (R-8) — /legal/terms (the app's "Terms" link): the terms PUBLISHED
// for use of Aramo Sign. Business organizations use Aramo Sign under their own
// agreement with the operator; no Business terms text is published here (a draft
// is never presented as approved).
export function TermsIndexPage() {
  return (
    <Shell title="Terms" testId="legal-terms-index">
      <h1 className="sg-h1">Aramo Sign terms</h1>
      <div className="sg-legal__doc">
        <h2>Personal accounts</h2>
        <p>A Personal (free) account is used under these terms, together with the Acceptable Use Policy:</p>
        <CurrentDocuments slugs={['personal-terms', 'acceptable-use']} testId="legal-terms-personal" />
        <h2>Business accounts</h2>
        <p data-testid="legal-terms-business">
          An organization uses Aramo Sign under its agreement with {ARAMO_SIGN_IDENTITY.legalEntity}. Ask your organization’s
          administrator for that agreement, or write to <a href={`mailto:${ARAMO_SIGN_IDENTITY.supportEmail}`}>{ARAMO_SIGN_IDENTITY.supportEmail}</a>. The
          Acceptable Use Policy applies to every account.
        </p>
        <h2>Everyone, including people who sign</h2>
        <CurrentDocuments slugs={['privacy', 'acceptable-use']} testId="legal-terms-all" />
        <p>
          All published documents: <a href={LEGAL_INDEX_PATH}>Legal</a>.
        </p>
      </div>
    </Shell>
  );
}

export function LegalDocumentPage() {
  const { slug = '', version } = useParams<{ slug: string; version?: string }>();
  const { catalog, texts, now } = useContext(LegalEnvContext);
  if (slug === SUBPROCESSORS_SLUG && version === undefined) return <SubprocessorsPage />;
  const at = now();
  const doc = findLegal(slug, version, catalog, at);
  const text = doc === null ? undefined : texts[`${doc.slug}@${doc.version}`];
  if (doc === null || text === undefined) return <LegalNotFound />;
  const status = legalEntryStatus(doc, catalog, at);
  const current = currentLegal(doc.slug, catalog, at);
  const stable = legalPath(doc.slug, doc.version, catalog, at);
  const currentLink =
    current === null ? null : (
      <a href={legalPath(current.slug, current.version, catalog, at)} data-testid="legal-current-link">
        {current.version}
      </a>
    );
  return (
    <Shell title={doc.title} testId="legal-document">
      {status.state === 'upcoming' ? (
        <p className="sg-legal__banner" role="note" data-testid="legal-upcoming">
          Upcoming — effective {formatEffective(doc.effective_from)}
          {currentLink !== null ? <>; the current version is {currentLink}.</> : '.'}
        </p>
      ) : null}
      {status.state === 'superseded' && status.superseded_by !== null ? (
        <p className="sg-legal__banner" role="note" data-testid="legal-superseded">
          No longer in effect since {formatEffective(status.superseded_by.effective_from)}
          {currentLink !== null ? <>; the current version is {currentLink}.</> : '.'}
        </p>
      ) : null}
      <p className="sg-legal__meta" data-testid="legal-meta">
        Version {doc.version} · Permanent link: <a href={stable}>{`${PUBLIC_SIGN_ORIGIN}${stable}`}</a>
        {status.state !== 'effective' && current !== null ? (
          <>
            {' '}
            · This is not the current version. <a href={legalPath(doc.slug, undefined, catalog, at)}>Read the current version</a>.
          </>
        ) : null}
      </p>
      <article>
        <Markdown source={text.text} />
      </article>
    </Shell>
  );
}

export function ThirdPartyNoticesPage() {
  return (
    <Shell title="Third-party notices" testId="legal-third-party">
      <h1 className="sg-h1">Third-party notices</h1>
      <div className="sg-legal__doc">
        <h2>MaxMind GeoLite2</h2>
        <p data-testid="maxmind-attribution">
          {MAXMIND_ATTRIBUTION.replace('https://www.maxmind.com.', '')}
          <a href="https://www.maxmind.com" target="_blank" rel="noopener noreferrer">
            https://www.maxmind.com
          </a>
          .
        </p>
      </div>
    </Shell>
  );
}

function SubprocessorTable({ list, testId }: { list: SubprocessorList; testId: string }) {
  return (
    <table data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">Provider</th>
          <th scope="col">What it does</th>
          <th scope="col">Location</th>
        </tr>
      </thead>
      <tbody>
        {list.rows.map((s) => (
          <tr key={`${s.name}|${s.purpose}`}>
            <td>{s.name}</td>
            <td>
              {s.purpose}
              {s.note !== undefined ? (
                <>
                  <br />
                  <span className="sg-muted" data-testid="subprocessor-note">
                    {s.note}
                  </span>
                </>
              ) : null}
            </td>
            <td>{s.location}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SubprocessorsPage() {
  const { catalog, subprocessors, now } = useContext(LegalEnvContext);
  const at = now();
  const current = currentSubprocessors(subprocessors, at);
  const upcoming = upcomingSubprocessors(subprocessors, at);
  if (current === null) return <LegalNotFound />;
  const privacy = legalPath('privacy', undefined, catalog, at);
  return (
    <Shell title="Subprocessors" testId="legal-subprocessors">
      <h1 className="sg-h1">Aramo Sign subprocessors</h1>
      <p className="sg-legal__meta" data-testid="subprocessors-updated">
        Last updated {current.updated ?? current.effective_from}
      </p>
      <div className="sg-legal__doc">
        <p data-testid="subprocessors-scope">
          The service providers that process personal information for {current.scope}, on our instructions. See the{' '}
          <a href={privacy}>Aramo Privacy Notice</a>.
        </p>
        <SubprocessorTable list={current} testId="subprocessors-table" />
        {upcoming !== null && upcoming.effective_from !== null ? (
          <section data-testid="subprocessors-upcoming">
            <h2>Upcoming changes, effective {formatEffective(upcoming.effective_from)}</h2>
            <p>
              From that date, the service providers that process personal information for {upcoming.scope}, on our instructions:
            </p>
            <SubprocessorTable list={upcoming} testId="subprocessors-upcoming-table" />
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
