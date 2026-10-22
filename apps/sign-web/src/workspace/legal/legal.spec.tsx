import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import { LEGAL_CATALOG, MAXMIND_ATTRIBUTION, PUBLIC_SIGN_ORIGIN, footerLegalLinks, legalPath } from './catalog';
import { LegalAcceptanceGate } from './LegalAcceptance';
import { Markdown, parseMarkdown } from './markdown';
import { LEGAL_TEXTS } from './texts';

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
}

function registry(): RegistryEntry[] {
  const re = /\{\s*key: '([^']+)',\s*version: '([^']+)',\s*status: '(\w+)',\s*path: '([^']+)',\s*sha256: '([0-9a-f]{64})',\s*url: (null|'[^']*'),?\s*\}/g;
  return [...REGISTRY_SRC.matchAll(re)].map((m) => ({
    key: m[1]!,
    version: m[2]!,
    status: m[3]!,
    path: m[4]!,
    sha256: m[5]!,
    url: m[6] === 'null' ? null : m[6]!.slice(1, -1),
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
  });

  it.each(LEGAL_CATALOG.map((d) => [`${d.slug}@${d.version}`, d] as const))('%s: bundled text hashes to the APPROVED registry sha256, same key/version/URL', (_id, d) => {
    const bundled = LEGAL_TEXTS[`${d.slug}@${d.version}`];
    expect(bundled).toBeDefined();
    const entry = registry().find((r) => r.path === bundled!.path && r.version === d.version);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('APPROVED');
    expect(entry!.key).toBe(d.key);
    expect(entry!.url).toBe(`${PUBLIC_SIGN_ORIGIN}${legalPath(d.slug, d.version)}`);
    expect(sha256(bundled!.text)).toBe(entry!.sha256);
    // And the bundle is the file on disk, byte for byte.
    expect(bundled!.text).toBe(readFileSync(resolve(ROOT, bundled!.path), 'utf8'));
  });

  it('every APPROVED registry entry is published here, and nothing else is', () => {
    const approved = registry().filter((r) => r.status === 'APPROVED');
    expect(approved.map((r) => `${r.key}@${r.version}`).sort()).toEqual(LEGAL_CATALOG.map((d) => `${d.key}@${d.version}`).sort());
    expect(Object.keys(LEGAL_TEXTS).sort()).toEqual(LEGAL_CATALOG.map((d) => `${d.slug}@${d.version}`).sort());
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

  it.each(['/legal/privacy/9.9', '/legal/unknown', '/legal/unknown/1.0', '/legal', '/legal/privacy/1.0/extra'])('%s → not found', async (path) => {
    at(path);
    expect(await screen.findByTestId('legal-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('legal-document')).toBeNull();
  });

  it('/legal/third-party-notices carries the MaxMind GeoLite2 attribution', async () => {
    at('/legal/third-party-notices');
    expect(await screen.findByTestId('maxmind-attribution')).toHaveTextContent(MAXMIND_ATTRIBUTION);
    expect(screen.getByRole('link', { name: 'https://www.maxmind.com' })).toHaveAttribute('href', 'https://www.maxmind.com');
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
