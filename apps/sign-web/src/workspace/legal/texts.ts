// The approved legal texts, bundled at build time byte-for-byte from doc/legal/
// (Vite `?raw`). Keyed `<slug>@<version>`; the repo path is kept beside each text
// so the build-time spec can match it to the registry entry pinning its SHA-256.
// The texts are DATA files of the repo (doc/legal is no Nx project): a raw text
// import, not a code dependency across a project boundary.
// eslint-disable-next-line @nx/enforce-module-boundaries -- raw legal text (doc/legal), not code
import personalTerms10 from '../../../../../doc/legal/aramo-sign/personal-terms-of-service.md?raw';
// eslint-disable-next-line @nx/enforce-module-boundaries -- raw legal text (doc/legal), not code
import privacy10 from '../../../../../doc/legal/aramo/privacy-notice.md?raw';
// eslint-disable-next-line @nx/enforce-module-boundaries -- raw legal text (doc/legal), not code
import acceptableUse10 from '../../../../../doc/legal/aramo/acceptable-use-policy.md?raw';

export interface LegalText {
  path: string;
  text: string;
}

export const LEGAL_TEXTS: Readonly<Record<string, LegalText>> = {
  'personal-terms@1.0': { path: 'doc/legal/aramo-sign/personal-terms-of-service.md', text: personalTerms10 },
  'privacy@1.0': { path: 'doc/legal/aramo/privacy-notice.md', text: privacy10 },
  'acceptable-use@1.0': { path: 'doc/legal/aramo/acceptable-use-policy.md', text: acceptableUse10 },
};
