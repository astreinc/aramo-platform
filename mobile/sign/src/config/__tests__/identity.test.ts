// M-A7 §5.1 (R-8, G-6) — the app's links open real public pages, and the About
// identity block is the published Privacy Notice text.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PRODUCTION_API_BASE_URL, WEB_LINKS } from '../env';
import { ARAMO_SIGN_IDENTITY, PRIVACY_MAILTO, SUPPORT_MAILTO } from '../identity';

const REPO = resolve(__dirname, '../../../../..');

describe('M-A7 §5.1 — web links and identity', () => {
  it('Terms, Privacy and Help point at the public sign-web pages that exist', () => {
    expect(PRODUCTION_API_BASE_URL).toBe('https://sign.aramo.ai');
    expect(WEB_LINKS).toEqual({
      terms: 'https://sign.aramo.ai/legal/terms',
      personalTerms: 'https://sign.aramo.ai/legal/personal-terms',
      privacy: 'https://sign.aramo.ai/legal/privacy',
      help: 'https://sign.aramo.ai/help',
    });
    // Each path is a public route of sign-web (App.tsx) and a published catalog slug.
    const app = readFileSync(resolve(REPO, 'apps/sign-web/src/workspace/App.tsx'), 'utf8');
    for (const route of ['/legal/terms', '/help', '/legal/:slug']) expect(app).toContain(`path="${route}"`);
    const catalog = readFileSync(resolve(REPO, 'apps/sign-web/src/workspace/legal/catalog.ts'), 'utf8');
    expect(catalog).toContain("slug: 'personal-terms'");
    expect(catalog).toContain("slug: 'privacy'");
  });

  it('the identity block is the published Privacy Notice 1.0 §17 text, verbatim (one block for app and web)', () => {
    const privacy = readFileSync(resolve(REPO, 'doc/legal/aramo/privacy-notice.md'), 'utf8');
    const id = ARAMO_SIGN_IDENTITY;
    expect(privacy).toContain(`Postal: ${id.legalEntity}, ${id.postalAddress}`);
    expect(privacy).toContain(`Privacy requests: ${id.privacyEmail}`);
    expect(privacy).toContain(`General support: ${id.supportEmail}`);
    expect(SUPPORT_MAILTO).toBe('mailto:support@aramo.ai');
    expect(PRIVACY_MAILTO).toBe('mailto:privacy@aramo.ai');
    const web = readFileSync(resolve(REPO, 'apps/sign-web/src/workspace/legal/identity.ts'), 'utf8');
    for (const v of Object.values(id)) expect(web).toContain(`'${v}'`);
  });
});
