import { useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import { LEGAL_CATALOG, MAXMIND_ATTRIBUTION, PUBLIC_SIGN_ORIGIN, THIRD_PARTY_NOTICES_PATH, findLegal, latestLegal, legalPath } from './catalog';
import { Markdown } from './markdown';
import { LEGAL_TEXTS } from './texts';

// Aramo Sign Personal (Free) — the published legal texts on sign.aramo.ai
// (public, no sign-in): /legal/:slug (latest) and /legal/:slug/:version (exact).
// The page shows the bundled text exactly as approved (rendered safely, never as
// HTML); an unknown document or version is a not-found page, never a fallback to
// another version.

function Shell({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
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
  const slugs = [...new Set(LEGAL_CATALOG.map((d) => d.slug))];
  return (
    <footer className="sg-legal__foot" aria-label="Legal">
      {slugs.map((s) => {
        const d = latestLegal(s)!;
        return (
          <a key={s} href={legalPath(d.slug, d.version)}>
            {d.title}
          </a>
        );
      })}
      <a href={THIRD_PARTY_NOTICES_PATH}>Third-party notices</a>
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

export function LegalDocumentPage() {
  const { slug = '', version } = useParams<{ slug: string; version?: string }>();
  const doc = findLegal(slug, version);
  const text = doc === null ? undefined : LEGAL_TEXTS[`${doc.slug}@${doc.version}`];
  if (doc === null || text === undefined) return <LegalNotFound />;
  const latest = latestLegal(doc.slug)!;
  const stable = legalPath(doc.slug, doc.version);
  return (
    <Shell title={doc.title} testId="legal-document">
      <p className="sg-legal__meta" data-testid="legal-meta">
        Version {doc.version} · Permanent link: <a href={stable}>{`${PUBLIC_SIGN_ORIGIN}${stable}`}</a>
        {latest.version !== doc.version ? (
          <>
            {' '}
            · This is not the current version. <a href={legalPath(doc.slug)}>Read the current version</a>.
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
