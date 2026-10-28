// Amendment M-A7 §5.2 (R-11) — "Report" from the received-envelope view. The app
// calls POST /v1/sign/inbox/:id/report on the WORKSPACE client: the server resolves
// the user's own claimed inbox item, so no signing token is handled for a report.
// It is the same report flow as the emailed "Report this email" link (one report per
// recipient per envelope; Business reports go to Aramo operators, Personal reports
// keep the Personal automatic pause rules) — the server decides all of that.
import { isApiError } from '../../api/errors';
import type { WorkspaceClient } from '../../api/workspaceClient';

/** The reasons offered (the same keys and labels as the web report page). */
export const REPORT_REASONS = [
  { key: 'phishing', label: 'Phishing', sub: 'It asks for passwords, payment or personal details' },
  { key: 'impersonation', label: 'Impersonation', sub: 'It pretends to be a person or company it isn’t' },
  { key: 'spam', label: 'Spam', sub: 'I didn’t expect or want this document' },
  { key: 'other', label: 'Something else', sub: 'Something else is wrong' },
] as const;

export type ReportReasonKey = (typeof REPORT_REASONS)[number]['key'];

export type ReportOutcome = 'sent' | 'already' | 'gone' | 'failed';

/** User copy per outcome. */
export const REPORT_COPY: Record<ReportOutcome, string> = {
  sent: 'Thanks — we’ll look into it.',
  already: 'You’ve already reported this.',
  gone: 'This envelope is no longer in your inbox.',
  failed: 'Couldn’t send your report. Try again.',
};

export async function reportInboxItem(
  workspace: WorkspaceClient,
  inboxItemId: string,
  reason: ReportReasonKey,
): Promise<ReportOutcome> {
  try {
    await workspace.call('/v1/sign/inbox/{id}/report', 'post', {
      path: { id: inboxItemId },
      body: { reason },
    });
    return 'sent';
  } catch (e) {
    if (isApiError(e) && e.status === 409) return 'already';
    if (isApiError(e) && e.status === 404) return 'gone';
    return 'failed';
  }
}
