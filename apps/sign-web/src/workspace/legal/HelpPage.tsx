import { useContext } from 'react';

import { legalPath } from './catalog';
import { ARAMO_SIGN_IDENTITY, TERMS_INDEX_PATH } from './identity';
import { LegalEnvContext, Shell } from './LegalPage';

// Aramo-Sign-Mobile-Amendment-M-A7 §5.1 (R-8, G-6) — the public help page
// (sign.aramo.ai/help, no sign-in; the app's "Help" link). Basic help for people
// who sign and for account holders, how to report a suspicious email (§5.2), and
// the one identity block: developer and legal entity, postal address, support and
// privacy contacts (./identity.ts).
export function HelpPage() {
  const { catalog, now } = useContext(LegalEnvContext);
  const at = now();
  const id = ARAMO_SIGN_IDENTITY;
  return (
    <Shell title="Help" testId="help-page">
      <h1 className="sg-h1">Aramo Sign help</h1>
      <div className="sg-legal__doc">
        <h2>Signing a document you received</h2>
        <ul>
          <li>Open the document from the button in the email you received. You don’t need an account to sign.</li>
          <li>Your signing link is personal to you. Don’t forward it.</li>
          <li>
            Questions about the document itself, or a link that no longer works? Contact the person or organization that sent it: only
            they can change or resend it.
          </li>
          <li>You can decline to sign from the signing page. The sender sees that you declined and the reason you give.</li>
        </ul>

        <h2>A suspicious email or document</h2>
        <ul>
          <li>
            Every signing request and reminder email has a <strong>Report this email</strong> link at the bottom. The signing page and the
            Aramo Sign app have a Report action too. You don’t need an account to report.
          </li>
          <li>Our team reviews every report. Don’t open links or sign documents from an email you don’t trust.</li>
          <li>
            What isn’t allowed on Aramo Sign is set out in the <a href={legalPath('acceptable-use', undefined, catalog, at)}>Acceptable Use Policy</a>.
          </li>
        </ul>

        <h2>Your account</h2>
        <ul>
          <li>Sign in on the web at sign.aramo.ai, or in the Aramo Sign app.</li>
          <li>
            If your account belongs to an organization, its administrators manage your access. Ask them first about access and about the
            organization’s documents.
          </li>
          <li>
            The terms that apply to you: <a href={TERMS_INDEX_PATH}>Aramo Sign terms</a>.
          </li>
        </ul>

        <h2>Privacy</h2>
        <p>
          How we handle personal information is described in the <a href={legalPath('privacy', undefined, catalog, at)}>Aramo Privacy Notice</a>. To
          ask for access to, a copy of, a correction to or the deletion of your information, write to{' '}
          <a href={`mailto:${id.privacyEmail}`}>{id.privacyEmail}</a>.
        </p>

        <h2>Contact</h2>
        <dl data-testid="help-identity">
          <dt>Developer and operator</dt>
          <dd data-testid="help-identity-entity">{id.legalEntity}</dd>
          <dt>Postal address</dt>
          <dd data-testid="help-identity-address">{id.postalAddress}</dd>
          <dt>Support, abuse and security</dt>
          <dd>
            <a href={`mailto:${id.supportEmail}`} data-testid="help-identity-support">
              {id.supportEmail}
            </a>
          </dd>
          <dt>Privacy</dt>
          <dd>
            <a href={`mailto:${id.privacyEmail}`} data-testid="help-identity-privacy">
              {id.privacyEmail}
            </a>
          </dd>
        </dl>
      </div>
    </Shell>
  );
}
