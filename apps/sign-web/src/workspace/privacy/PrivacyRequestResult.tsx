import type { PrivacyRequestView } from '../api';
import { ARAMO_SIGN_IDENTITY } from '../legal/identity';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — what the requester sees: the identifier, a
// meaningful status, and an accurate account of what is kept and why. Shared by the
// public /delete-account page and the signed-in Settings section (no @aramo import,
// so the public page stays light).

export const DELETE_ACCOUNT_PATH = '/delete-account';

const TYPE_LABEL: Record<string, string> = {
  DELETION: 'Delete my account or personal information',
  ACCESS: 'See my data',
  EXPORT: 'Get a copy of my data',
  CORRECTION: 'Correct my data',
};

export function requestTypeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function PrivacyRequestResult({ request, testId = 'privacy-request-result' }: { request: PrivacyRequestView; testId?: string }) {
  return (
    <div className="privacy-result" data-testid={testId}>
      <dl className="privacy-result__facts">
        <dt>Request ID</dt>
        <dd data-testid="privacy-reference" style={{ fontFamily: 'monospace', fontWeight: 600 }}>
          {request.reference}
        </dd>
        <dt>Request</dt>
        <dd>{requestTypeLabel(request.request_type)}</dd>
        <dt>Status</dt>
        <dd data-testid="privacy-status">{request.status_label}</dd>
        <dt>{request.completed_at !== null ? 'Closed on' : 'We answer by'}</dt>
        <dd>{day(request.completed_at ?? request.due_at)}</dd>
      </dl>
      {request.outcome_text !== null ? <p data-testid="privacy-outcome">{request.outcome_text}</p> : null}
      {request.organization_decides !== null ? <p data-testid="privacy-organization">{request.organization_decides}</p> : null}
      {request.retained.length > 0 ? (
        <>
          <p style={{ marginBottom: 4 }}>What we keep, and why:</p>
          <ul data-testid="privacy-retained" style={{ marginTop: 0, paddingLeft: 20 }}>
            {request.retained.map((r) => (
              <li key={r.key}>
                <strong>{r.label}.</strong> {r.why}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="privacy-result__contact">
        Keep the request ID. Questions: <a href={`mailto:${ARAMO_SIGN_IDENTITY.privacyEmail}`}>{ARAMO_SIGN_IDENTITY.privacyEmail}</a>
      </p>
    </div>
  );
}
