import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SignedOut, ToastProvider, useSession } from '@aramo/fe-foundation';

import { LoginPage } from './LoginPage';
import { PortalShell } from './shell/PortalShell';
import { RecordsListView } from './records/RecordsListView';
import { RecordDetailView } from './records/RecordDetailView';
import { VerificationsView } from './verifications/VerificationsView';
import { DisputesListView } from './disputes/DisputesListView';
import { DisputeDetailView } from './disputes/DisputeDetailView';
import { NoticeView } from './notice/NoticeView';
import { RightsView } from './rights/RightsView';

// Portal P1 PR-3 — the portal app root.
//
// The portal login is PASSWORDLESS (request-link / consume), NOT the OAuth
// redirect the platform/recruiter consumers use — so, unlike platform-web, an
// unauthenticated session does NOT redirect to an IdP. It renders the LoginPage
// (email entry → neutral confirmation) in place. This is also the session-expired
// path: when the shared session lapses, useSession flips to `unauthenticated` and
// the talent lands back on the email-entry page.
//
// The link-consumed landing is the authenticated records view: the magic link
// hits the backend consume endpoint (auth-service), which sets the session cookie
// and redirects to the SPA — booting authenticated straight into the records.
export function App() {
  const state = useSession();
  const location = useLocation();

  // T2-E1-HF3 — the PUBLIC signed-out landing. The shared logout GET reaches
  // deriveSignoutRedirect and returns the browser to /signed-out; render it
  // session-less BEFORE any session gate so it is stable on refresh and starts
  // no authentication. Portal's passwordless login mechanism is unchanged.
  if (location.pathname === '/signed-out') {
    return (
      <ToastProvider>
        <SignedOut />
      </ToastProvider>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="po-splash" role="status">
        Loading…
      </div>
    );
  }

  if (state.status !== 'authenticated') {
    return (
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <PortalShell>
        <Routes>
          <Route path="/" element={<RecordsListView />} />
          <Route path="/records/:id" element={<RecordDetailView />} />
          <Route path="/verifications" element={<VerificationsView />} />
          <Route path="/disputes" element={<DisputesListView />} />
          <Route path="/disputes/:id" element={<DisputeDetailView />} />
          <Route path="/notice" element={<NoticeView />} />
          <Route path="/rights" element={<RightsView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </PortalShell>
    </ToastProvider>
  );
}
