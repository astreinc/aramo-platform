import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup as cleanupRender, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import {
  LEGAL_CATALOG,
  MAXMIND_ATTRIBUTION,
  PUBLIC_SIGN_ORIGIN,
  SUBPROCESSOR_LISTS,
  currentLegal,
  currentSubprocessors,
  effectiveTime,
  footerLegalLinks,
  formatEffective,
  legalEntryStatus,
  legalPath,
  upcomingSubprocessors,
  type LegalCatalogEntry,
  type SubprocessorList,
} from './catalog';
import { LegalAcceptanceGate } from './LegalAcceptance';
import { LegalEnvContext, type LegalEnv } from './LegalPage';
import { Markdown, parseMarkdown } from './markdown';
import { LEGAL_TEXTS } from './texts';
import { ARAMO_SIGN_IDENTITY } from './identity';

// Aramo Sign Personal (Free) — the published legal texts.
// BUILD-TIME GUARD: the text bundled into sign-web (Vite ?raw) must hash to the
// sha256 the legal registry (@aramo/subscription legal-documents.ts) pins for each
// APPROVED entry, with the same key, version and URL — and every APPROVED entry is
// served. So the page can never show a text other than the one people accepted.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const ROOT = resolve(__dirname, '../../../../..');
const REGISTRY_SRC = readFileSync(resolve(ROOT, 'libs/subscription/src/lib/legal/legal-documents.ts'), 'utf8');

interface RegistryEntry {
  key: string;
  version: string;
  status: string;
  path: string;
  sha256: string;
  url: string | null;
  effective_from: string | null;
}

function registry(): RegistryEntry[] {
  const re =
    /\{\s*key: '([^']+)',\s*version: '([^']+)',\s*status: '(\w+)',\s*path: '([^']+)',\s*sha256: '([0-9a-f]{64})',\s*url: (null|'[^']*'),\s*(?:\/\/[^\n]*\n\s*)*effective_from: (null|'[^']*'),?\s*\}/g;
  const unquote = (v: string) => (v === 'null' ? null : v.slice(1, -1));
  return [...REGISTRY_SRC.matchAll(re)].map((m) => ({
    key: m[1]!,
    version: m[2]!,
    status: m[3]!,
    path: m[4]!,
    sha256: m[5]!,
    url: unquote(m[6]!),
    effective_from: unquote(m[7]!),
  }));
}

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function at(path: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({}, 401)),
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('legal texts — build-time integrity against the registry', () => {
  it('the registry source parses (all entries found)', () => {
    expect(registry().length).toBeGreaterThanOrEqual(7);
    expect(registry().length).toBe((REGISTRY_SRC.match(/\bsha256: '/g) ?? []).length);
  });

  it.each(LEGAL_CATALOG.map((d) => [`${d.slug}@${d.version}`, d] as const))('%s: bundled text hashes to the APPROVED registry sha256, same key/version/URL/effective_from', (_id, d) => {
    const bundled = LEGAL_TEXTS[`${d.slug}@${d.version}`];
    expect(bundled).toBeDefined();
    const entry = registry().find((r) => r.path === bundled!.path && r.version === d.version);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('APPROVED');
    expect(entry!.key).toBe(d.key);
    expect(entry!.url).toBe(`${PUBLIC_SIGN_ORIGIN}${legalPath(d.slug, d.version)}`);
    // E-5 — the catalog serves a version from the same instant the registry makes it effective.
    expect(d.effective_from).toBe(entry!.effective_from);
    expect(effectiveTime(d.effective_from)).not.toBeNull();
    expect(sha256(bundled!.text)).toBe(entry!.sha256);
    // And the bundle is the file on disk, byte for byte.
    expect(bundled!.text).toBe(readFileSync(resolve(ROOT, bundled!.path), 'utf8'));
  });

  it('every APPROVED, scheduled registry entry is published here, and nothing else is', () => {
    const approved = registry().filter((r) => r.status === 'APPROVED' && r.url !== null && r.effective_from !== null);
    expect(approved.map((r) => `${r.key}@${r.version}`).sort()).toEqual(LEGAL_CATALOG.map((d) => `${d.key}@${d.version}`).sort());
    expect(Object.keys(LEGAL_TEXTS).sort()).toEqual(LEGAL_CATALOG.map((d) => `${d.slug}@${d.version}`).sort());
  });

  it('Privacy Notice 1.0 is byte-for-byte unchanged: the bundled text still hashes to 18fcc1aa386a06c0…', () => {
    expect(sha256(LEGAL_TEXTS['privacy@1.0']!.text)).toBe('18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6');
    expect(registry().find((r) => r.key === 'aramo.privacy_notice' && r.version === '1.0')!.sha256).toBe('18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6');
  });

  it('no 1.1 is registered or published (its text is not approved)', () => {
    expect(registry().some((r) => r.version === '1.1')).toBe(false);
    expect(LEGAL_CATALOG.some((d) => d.version === '1.1')).toBe(false);
  });
});

describe('/legal pages (public)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('/legal/<slug>/<version> renders the exact document with its version and permanent link (no sign-in)', async () => {
    at('/legal/privacy/1.0');
    const page = await screen.findByTestId('legal-document');
    expect(within(page).getByRole('heading', { level: 1, name: 'Aramo Privacy Notice' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-meta')).toHaveTextContent('Version 1.0 · Permanent link: https://sign.aramo.ai/legal/privacy/1.0');
    expect(within(page).getByRole('heading', { level: 2, name: '1. Summary' })).toHaveAttribute('id', '1-summary');
    expect(within(page).getAllByRole('table').length).toBeGreaterThan(0);
  });

  it('/legal/<slug> serves the latest version', async () => {
    at('/legal/personal-terms');
    expect(await screen.findByRole('heading', { level: 1, name: 'Aramo Sign — Personal Terms of Service' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-meta')).toHaveTextContent('Version 1.0');
    at('/legal/acceptable-use');
    expect(await screen.findByRole('heading', { level: 1, name: 'Aramo — Acceptable Use Policy' })).toBeInTheDocument();
  });

  it.each(['/legal/privacy/9.9', '/legal/unknown', '/legal/unknown/1.0', '/legal/privacy/1.0/extra'])('%s → not found', async (path) => {
    at(path);
    expect(await screen.findByTestId('legal-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('legal-document')).toBeNull();
  });

  it('/legal/third-party-notices carries the MaxMind GeoLite2 attribution', async () => {
    at('/legal/third-party-notices');
    expect(await screen.findByTestId('maxmind-attribution')).toHaveTextContent(MAXMIND_ATTRIBUTION);
    expect(screen.getByRole('link', { name: 'https://www.maxmind.com' })).toHaveAttribute('href', 'https://www.maxmind.com');
  });

  it('/legal/subprocessors lists the Personal subprocessors with a last-updated date, and the Privacy Notice links to it', async () => {
    at('/legal/subprocessors');
    const page = await screen.findByTestId('legal-subprocessors');
    expect(screen.getByTestId('subprocessors-updated')).toHaveTextContent('Last updated 2026-10-22');
    expect(screen.getByTestId('subprocessors-scope')).toHaveTextContent('The service providers that process personal information for Aramo Sign Personal accounts, on our instructions.');
    const rows = within(screen.getByTestId('subprocessors-table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Amazon Web Services', 'Cloudflare', 'Google', 'Text-message (SMS) provider']);
    expect(rows).toHaveLength(currentSubprocessors()!.rows.length);
    // E-7 — the 1.1 list is unscheduled: nothing upcoming is shown publicly.
    expect(screen.queryByTestId('subprocessors-upcoming')).toBeNull();
    expect(page).not.toHaveTextContent('Apple');
    expect(page).toHaveTextContent('no phone numbers are shared until one is');
    expect(within(page).getByRole('link', { name: 'Subprocessors' })).toHaveAttribute('href', '/legal/subprocessors');
    expect(LEGAL_TEXTS['privacy@1.0']!.text).toContain('https://sign.aramo.ai/legal/subprocessors');
  });

  it('/legal/subprocessors/<version> is not found (the list is not a versioned registry text)', async () => {
    at('/legal/subprocessors/1.0');
    expect(await screen.findByTestId('legal-not-found')).toBeInTheDocument();
  });
});

describe('Markdown renderer (safe subset)', () => {
  it('renders headings, lists with continuation lines, tables, bold/italic/code; HTML in the source stays text', () => {
    const src = [
      '# Title',
      '',
      '| | |',
      '|---|---|',
      '| Version | **1.0** |',
      '',
      '- one **bold**',
      '  continued',
      '- two *it* and `code`',
      '',
      '<script>alert(1)</script> <img src=x onerror=alert(1)>',
      '',
      '---',
    ].join('\n');
    expect(parseMarkdown(src).map((b) => b.k)).toEqual(['h', 'table', 'ul', 'p', 'hr']);
    const { container } = render(<Markdown source={src} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelector('td strong')?.textContent).toBe('1.0');
    expect([...container.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['one bold continued', 'two it and code']);
    expect(container.querySelector('li em')?.textContent).toBe('it');
    expect(container.querySelector('li code')?.textContent).toBe('code');
  });
});

describe('workspace legal links and re-acceptance', () => {
  it('footer: Personal accounts see Terms, Privacy and Acceptable Use; Business only the documents binding every account', () => {
    expect(footerLegalLinks(true)).toEqual([
      { label: 'Terms', href: '/legal/personal-terms/1.0' },
      { label: 'Privacy', href: '/legal/privacy/1.0' },
      { label: 'Acceptable Use', href: '/legal/acceptable-use/1.0' },
    ]);
    expect(footerLegalLinks(false).map((l) => l.label)).toEqual(['Privacy', 'Acceptable Use']);
  });

  const PENDING = [
    { key: 'sign.personal_terms_of_service', version: '1.1', url: 'https://sign.aramo.ai/legal/personal-terms/1.1', title: 'Aramo Sign Personal Terms of Service' },
    { key: 'aramo.privacy_notice', version: '1.0', url: 'https://sign.aramo.ai/legal/privacy/1.0', title: 'Aramo Privacy Notice' },
  ];

  it('nothing pending → no dialog', async () => {
    const load = vi.fn(async () => ({ pending: [] }));
    const { container } = render(<LegalAcceptanceGate load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('legal-accept-dialog')).toBeNull();
  });

  it('pending documents → a blocking dialog listing each (new tab, version); accept needs the unticked box and sends the exact versions', async () => {
    const accept = vi.fn(async () => ({ pending: [] }));
    render(<LegalAcceptanceGate load={async () => ({ pending: PENDING })} accept={accept} />);
    const dialog = await screen.findByTestId('legal-accept-dialog');
    const links = within(screen.getByTestId('legal-accept-docs')).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')])).toEqual(PENDING.map((d) => [d.title, d.url, '_blank']));
    expect(screen.getByTestId('legal-accept-docs')).toHaveTextContent('(version 1.1)');
    const box = screen.getByTestId('legal-accept-check') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('legal-accept-submit')).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByTestId('legal-accept-dialog')).toBeInTheDocument();
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('legal-accept-submit'));
    await waitFor(() => expect(screen.queryByTestId('legal-accept-dialog')).toBeNull());
    expect(accept).toHaveBeenCalledWith(PENDING);
  });

  it('a refused acceptance keeps the dialog with the message and reloads the current list', async () => {
    const load = vi.fn(async () => ({ pending: PENDING }));
    const accept = vi.fn(async () => {
      throw new Error('stale');
    });
    render(<LegalAcceptanceGate load={load} accept={accept} />);
    fireEvent.click(await screen.findByTestId('legal-accept-check'));
    fireEvent.click(screen.getByTestId('legal-accept-submit'));
    expect(await screen.findByText('We couldn’t record your acceptance. Try again.')).toBeInTheDocument();
    expect(screen.getByTestId('legal-accept-dialog')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

// Privacy Notice 1.1 Remediation Directive §3 / decision 6 (E-5) — future-effective
// versions, against a FIXTURE catalog (no 1.1 text is approved or registered).
const P10 = LEGAL_CATALOG.find((d) => d.slug === 'privacy' && d.version === '1.0')!;
const P11: LegalCatalogEntry = { ...P10, version: '1.1', effective_from: '2026-11-25T00:00:00Z' };
const FIXTURE_CATALOG: readonly LegalCatalogEntry[] = [...LEGAL_CATALOG, P11];
const FIXTURE_TEXTS = { ...LEGAL_TEXTS, 'privacy@1.1': { path: 'test/privacy-1.1.md', text: '# Aramo Privacy Notice 1.1 (fixture)\n\nFixture text.\n' } };
const BEFORE = new Date('2026-11-24T23:59:59.999Z');
const AT = new Date('2026-11-25T00:00:00Z');

function atWith(path: string, env: Partial<LegalEnv>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({}, 401)),
  );
  const value: LegalEnv = { catalog: LEGAL_CATALOG, texts: LEGAL_TEXTS, subprocessors: SUBPROCESSOR_LISTS, now: () => new Date(), ...env };
  return render(
    <LegalEnvContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </LegalEnvContext.Provider>,
  );
}

describe('E-5 effective version — resolver over the catalog', () => {
  it('the current version is the latest effective_from <= now, never merely the last entry', () => {
    expect(currentLegal('privacy', FIXTURE_CATALOG, BEFORE)).toBe(P10);
    expect(currentLegal('privacy', FIXTURE_CATALOG, AT)).toBe(P11);
    expect(legalEntryStatus(P11, FIXTURE_CATALOG, BEFORE).state).toBe('upcoming');
    expect(legalEntryStatus(P10, FIXTURE_CATALOG, BEFORE).state).toBe('effective');
    expect(legalEntryStatus(P10, FIXTURE_CATALOG, AT)).toEqual({ state: 'superseded', superseded_by: P11 });
    expect(legalPath('privacy', undefined, FIXTURE_CATALOG, BEFORE)).toBe('/legal/privacy/1.0');
    expect(legalPath('privacy', undefined, FIXTURE_CATALOG, AT)).toBe('/legal/privacy/1.1');
  });

  it('timezone: an offset effective_from is an instant; the banner date is shown as authored', () => {
    const est: LegalCatalogEntry = { ...P11, effective_from: '2026-11-25T00:00:00-05:00' };
    const cat = [...LEGAL_CATALOG, est];
    expect(currentLegal('privacy', cat, new Date('2026-11-25T04:59:59Z'))).toBe(P10);
    expect(currentLegal('privacy', cat, new Date('2026-11-25T05:00:00Z'))).toBe(est);
    expect(formatEffective('2026-11-25T00:00:00Z')).toBe('2026-11-25 00:00 UTC');
    expect(formatEffective('2026-11-25T00:00:00-05:00')).toBe('2026-11-25 00:00 UTC-05:00');
  });

  it('footer and "current" links resolve to the effective version (before: 1.0; at the instant: 1.1)', () => {
    expect(footerLegalLinks(false, FIXTURE_CATALOG, BEFORE)).toEqual([
      { label: 'Privacy', href: '/legal/privacy/1.0' },
      { label: 'Acceptable Use', href: '/legal/acceptable-use/1.0' },
    ]);
    expect(footerLegalLinks(false, FIXTURE_CATALOG, AT)[0]).toEqual({ label: 'Privacy', href: '/legal/privacy/1.1' });
  });
});

describe('E-5 effective version — /legal routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('before the effective date /legal/privacy serves 1.0 with no banner', async () => {
    atWith('/legal/privacy', { catalog: FIXTURE_CATALOG, texts: FIXTURE_TEXTS, now: () => BEFORE });
    expect(await screen.findByTestId('legal-meta')).toHaveTextContent('Version 1.0 · Permanent link: https://sign.aramo.ai/legal/privacy/1.0');
    expect(screen.getByTestId('legal-meta')).not.toHaveTextContent('This is not the current version');
    expect(screen.queryByTestId('legal-upcoming')).toBeNull();
    expect(screen.queryByTestId('legal-superseded')).toBeNull();
  });

  it('/legal/privacy/1.1 before its date: "Upcoming — effective {date}; the current version is 1.0" with a link', async () => {
    atWith('/legal/privacy/1.1', { catalog: FIXTURE_CATALOG, texts: FIXTURE_TEXTS, now: () => BEFORE });
    const banner = await screen.findByTestId('legal-upcoming');
    expect(banner).toHaveTextContent('Upcoming — effective 2026-11-25 00:00 UTC; the current version is 1.0.');
    expect(screen.getByTestId('legal-current-link')).toHaveAttribute('href', '/legal/privacy/1.0');
    expect(screen.getByTestId('legal-meta')).toHaveTextContent('Version 1.1');
    expect(screen.getByRole('heading', { level: 1, name: 'Aramo Privacy Notice 1.1 (fixture)' })).toBeInTheDocument();
  });

  it('at exactly the effective instant /legal/privacy serves 1.1, and 1.0 shows "No longer in effect since {date}"', async () => {
    atWith('/legal/privacy', { catalog: FIXTURE_CATALOG, texts: FIXTURE_TEXTS, now: () => AT });
    expect(await screen.findByTestId('legal-meta')).toHaveTextContent('Version 1.1');
    expect(screen.queryByTestId('legal-upcoming')).toBeNull();
    cleanupRender();
    atWith('/legal/privacy/1.0', { catalog: FIXTURE_CATALOG, texts: FIXTURE_TEXTS, now: () => AT });
    expect(await screen.findByTestId('legal-superseded')).toHaveTextContent('No longer in effect since 2026-11-25 00:00 UTC; the current version is 1.1.');
    expect(screen.getByTestId('legal-current-link')).toHaveAttribute('href', '/legal/privacy/1.1');
    expect(screen.getByTestId('legal-meta')).toHaveTextContent('This is not the current version.');
    // The superseded 1.0 is still served (retained for historical access).
    expect(screen.getByRole('heading', { level: 2, name: '1. Summary' })).toBeInTheDocument();
  });

  it('the legal page footer links the effective version', async () => {
    atWith('/legal/acceptable-use', { catalog: FIXTURE_CATALOG, texts: FIXTURE_TEXTS, now: () => BEFORE });
    const page = await screen.findByTestId('legal-document');
    expect(within(page).getByRole('link', { name: 'Aramo Privacy Notice' })).toHaveAttribute('href', '/legal/privacy/1.0');
  });
});

// Privacy Notice 1.1 Remediation Directive decision 8 (E-7) — the versioned subprocessor list.
describe('E-7 subprocessor list', () => {
  afterEach(() => vi.unstubAllGlobals());

  const proposed = SUBPROCESSOR_LISTS.find((l) => l.id === 'privacy-1.1')!;

  it('the current list is unchanged; the 1.1 list is unscheduled (never shown) until counsel items are resolved', () => {
    expect(currentSubprocessors()!.id).toBe('2026-10-22');
    expect(upcomingSubprocessors()).toBeNull();
    expect(proposed.effective_from).toBeNull();
    expect(upcomingSubprocessors(SUBPROCESSOR_LISTS, new Date('2099-01-01T00:00:00Z'))).toBeNull();
    expect(currentSubprocessors(SUBPROCESSOR_LISTS, new Date('2099-01-01T00:00:00Z'))!.id).toBe('2026-10-22');
  });

  it('a list is scheduled only with a valid effective_from, a publication date and no open counsel items', () => {
    for (const l of SUBPROCESSOR_LISTS) {
      if (l.effective_from === null) continue;
      expect(effectiveTime(l.effective_from)).not.toBeNull();
      expect(l.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.pending_review).toEqual([]);
    }
  });

  it('the proposed list carries the validation report §6.1 rows and wording', () => {
    expect(proposed.scope).toBe('Aramo Sign (personal and business accounts, signers and the Aramo Sign mobile app)');
    const byPurpose = (p: string) => proposed.rows.find((r) => r.purpose.startsWith(p))!;
    expect(byPurpose('Sign-in with Google').purpose).toBe('Sign-in with Google (web and mobile app)');
    expect(byPurpose('Sign-in with Microsoft')).toMatchObject({ name: 'Microsoft', purpose: 'Sign-in with Microsoft for organizations (web and mobile app)' });
    expect(byPurpose('Apple Push Notification service')).toMatchObject({
      name: 'Apple',
      purpose: 'Apple Push Notification service: delivers notifications to iPhones running the Aramo Sign app, when the user allows notifications',
      note: 'Used only when notifications are switched on.',
    });
    expect(byPurpose('Firebase Cloud Messaging')).toMatchObject({
      name: 'Google',
      purpose: 'Firebase Cloud Messaging: delivers notifications to Android phones running the Aramo Sign app, when the user allows notifications',
      note: 'Used only when notifications are switched on.',
    });
    expect(proposed.rows.filter((r) => r.note !== undefined)).toHaveLength(2);
    expect(proposed.pending_review.length).toBeGreaterThan(0);
  });

  it('with a dated upcoming list the page shows "Upcoming changes, effective {date}"; from that instant it is the current list', async () => {
    const scheduled: SubprocessorList = { ...proposed, effective_from: '2026-11-25T00:00:00Z', updated: '2026-10-27', pending_review: [] };
    const lists = [SUBPROCESSOR_LISTS[0]!, scheduled];
    atWith('/legal/subprocessors', { subprocessors: lists, now: () => BEFORE });
    const upcoming = await screen.findByTestId('subprocessors-upcoming');
    expect(within(upcoming).getByRole('heading', { level: 2 })).toHaveTextContent('Upcoming changes, effective 2026-11-25 00:00 UTC');
    expect(upcoming).toHaveTextContent('Aramo Sign (personal and business accounts, signers and the Aramo Sign mobile app)');
    expect(within(screen.getByTestId('subprocessors-upcoming-table')).getAllByRole('row').slice(1)).toHaveLength(scheduled.rows.length);
    expect(screen.getByTestId('subprocessors-scope')).toHaveTextContent('for Aramo Sign Personal accounts, on our instructions');
    expect(screen.getByTestId('subprocessors-updated')).toHaveTextContent('Last updated 2026-10-22');
    cleanupRender();
    atWith('/legal/subprocessors', { subprocessors: lists, now: () => AT });
    expect(await screen.findByTestId('subprocessors-scope')).toHaveTextContent(
      'The service providers that process personal information for Aramo Sign (personal and business accounts, signers and the Aramo Sign mobile app), on our instructions.',
    );
    expect(screen.getByTestId('subprocessors-updated')).toHaveTextContent('Last updated 2026-10-27');
    expect(screen.queryByTestId('subprocessors-upcoming')).toBeNull();
    expect(screen.getAllByTestId('subprocessor-note').map((n) => n.textContent)).toEqual(['Used only when notifications are switched on.', 'Used only when notifications are switched on.']);
  });
});

// Aramo-Sign-Mobile-Amendment-M-A7 §5.1 (R-8, G-6) — the app's Terms and Help
// links open real public pages, and the identity block matches the Privacy Notice.
describe('M-A7 §5.1 — public /legal, /legal/terms and /help', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the identity block is the published Privacy Notice 1.0 §17 text, verbatim', () => {
    const privacy = LEGAL_TEXTS['privacy@1.0']!.text;
    const id = ARAMO_SIGN_IDENTITY;
    expect(privacy).toContain(`Postal: ${id.legalEntity}, ${id.postalAddress}`);
    expect(privacy).toContain(`Privacy requests: ${id.privacyEmail}`);
    expect(privacy).toContain(`General support: ${id.supportEmail}`);
  });

  it('/legal lists every published document in effect (no sign-in)', async () => {
    at('/legal');
    const list = await screen.findByTestId('legal-index-documents');
    for (const slug of ['personal-terms', 'privacy', 'acceptable-use']) {
      const d = currentLegal(slug)!;
      expect(within(list).getByRole('link', { name: d.title })).toHaveAttribute('href', `/legal/${slug}/${d.version}`);
    }
    expect(screen.queryByTestId('legal-not-found')).toBeNull();
  });

  it('/legal/terms (the app link) lists the published Personal Terms and AUP; Business terms are the organization agreement, never a draft', async () => {
    at('/legal/terms');
    const personal = await screen.findByTestId('legal-terms-personal');
    expect(within(personal).getByRole('link', { name: 'Aramo Sign Personal Terms of Service' })).toHaveAttribute('href', '/legal/personal-terms/1.0');
    expect(within(personal).getByRole('link', { name: 'Aramo Acceptable Use Policy' })).toHaveAttribute('href', '/legal/acceptable-use/1.0');
    expect(screen.getByTestId('legal-terms-business')).toHaveTextContent(`An organization uses Aramo Sign under its agreement with ${ARAMO_SIGN_IDENTITY.legalEntity}`);
    const page = screen.getByTestId('legal-terms-index');
    // The draft Business Terms of Service is never linked or named as published.
    expect(page.innerHTML).not.toMatch(/terms-of-service|0\.1\.1|sign\.terms_of_service/);
    expect(screen.queryByTestId('legal-not-found')).toBeNull();
  });

  it('/help is public and shows help, the report route, and the identity block with working contacts', async () => {
    at('/help');
    await screen.findByTestId('help-page');
    expect(screen.getByRole('heading', { level: 1, name: 'Aramo Sign help' })).toBeInTheDocument();
    expect(screen.getByText(/Report this email/)).toBeInTheDocument();
    expect(screen.getByTestId('help-identity-entity')).toHaveTextContent(ARAMO_SIGN_IDENTITY.legalEntity);
    expect(screen.getByTestId('help-identity-address')).toHaveTextContent(ARAMO_SIGN_IDENTITY.postalAddress);
    expect(screen.getByTestId('help-identity-support')).toHaveAttribute('href', 'mailto:support@aramo.ai');
    expect(screen.getByTestId('help-identity-privacy')).toHaveAttribute('href', 'mailto:privacy@aramo.ai');
    expect(screen.getByTestId('legal-footer-identity')).toHaveTextContent(ARAMO_SIGN_IDENTITY.legalEntity);
  });
});
