import { Navigate, Route, Routes } from 'react-router-dom';
import { RouteGuard, SignedOut, ToastProvider, logout, useSession } from '@aramo/fe-foundation';

import { Dashboard } from './pages/Dashboard';
import { EnvelopeActivity, EnvelopeDetail } from './pages/EnvelopeDetail';
import { EnvelopeList } from './pages/EnvelopeList';
import { EnvelopeSent, EnvelopeWizard, NewEnvelope } from './pages/EnvelopeWizard';
import { SettingsPage } from './pages/Settings';
import { ActivityPage, ContactsPage, DocumentsPage, ReportsPage, TemplatesPage } from './pages/WorkspacePages';
import { LoginPage } from './routes/LoginPage';
import { ConsoleShell } from './shell';
import { Btn } from './ui';
import { WorkspaceProvider, useSenderContext, type Workspace } from './workspace';
import type { SenderContext } from './api';

// PX-V1 §8 (D-4) + Lead Host & Workspace Ruling v1.0 — apps/esign-web on
// esign.aramo.ai, one sender application for BUSINESS and PERSONAL accounts:
//   /            resolves the workspace from the BACKEND context, then redirects
//   /sign/*      BUSINESS organization workspace (the prototype console)
//   /personal/*  PERSONAL workspace (route foundation; sending not enabled)
//   /login       login landing (?error=<CODE>), /signed-out public landing
// The route prefix never authorizes: the backend decides tenant, kind, entitlement
// and every action; a mismatched prefix is redirected to the backend's workspace.
// The external signer never comes here — that is sign.aramo.ai/s/<token>.

export function App({ contextLoader }: { contextLoader?: () => Promise<SenderContext> }) {
  const state = useSession();
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signed-out" element={<SignedOut offerAccountSwitch />} />
        <Route
          path="*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? <Authenticated scopes={state.session.scopes} {...(contextLoader !== undefined ? { contextLoader } : {})} /> : null}
            </RouteGuard>
          }
        />
      </Routes>
    </ToastProvider>
  );
}

function Authenticated({ scopes, contextLoader }: { scopes: readonly string[]; contextLoader?: () => Promise<SenderContext> }) {
  const ctx = useSenderContext(contextLoader);
  if (ctx.status === 'loading') return <FullState title="Opening Aramo Sign…" />;
  if (ctx.status === 'not_entitled')
    return (
      <FullState title="Aramo Sign isn’t part of your plan" testId="state-not-entitled">
        Your organization doesn’t have the Aramo Sign subscription. An organization admin can ask to add it.
      </FullState>
    );
  if (ctx.status === 'no_access')
    return (
      <FullState title="You don’t have access to Aramo Sign" testId="state-no-access">
        Your organization has Aramo Sign, but your account has no Sign role. Ask an organization admin for access.
      </FullState>
    );
  if (ctx.status === 'error')
    return (
      <FullState title="We couldn’t open Aramo Sign">
        {ctx.message}
        <div style={{ marginTop: 14 }}>
          <Btn variant="primary" onClick={ctx.retry}>
            Try again
          </Btn>
        </div>
      </FullState>
    );
  return (
    <WorkspaceProvider ctx={ctx.ctx}>
      <Routes>
        <Route path="/" element={<Navigate to={`/${ctx.ctx.workspace}`} replace />} />
        <Route path="/sign/*" element={<Gate expected="sign" actual={ctx.ctx.workspace} scopes={scopes} />} />
        <Route path="/personal/*" element={<Gate expected="personal" actual={ctx.ctx.workspace} scopes={scopes} />} />
        <Route path="*" element={<Navigate to={`/${ctx.ctx.workspace}`} replace />} />
      </Routes>
    </WorkspaceProvider>
  );
}

function Gate({ expected, actual, scopes }: { expected: Workspace; actual: Workspace; scopes: readonly string[] }) {
  if (expected !== actual) return <Navigate to={`/${actual}`} replace />;
  return (
    <ConsoleShell scopes={scopes}>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="envelopes" element={<EnvelopeList />} />
        <Route path="envelopes/new" element={<NewEnvelope />} />
        <Route path="envelopes/:id" element={<EnvelopeDetail />} />
        <Route path="envelopes/:id/edit" element={<EnvelopeWizard />} />
        <Route path="envelopes/:id/prepare" element={<EnvelopeWizard prepare />} />
        <Route path="envelopes/:id/sent" element={<EnvelopeSent />} />
        <Route path="envelopes/:id/activity" element={<EnvelopeActivity />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<Navigate to="personal" replace />} />
        <Route path="settings/:section" element={<SettingsPage />} />
        {expected === 'sign' ? (
          <>
            <Route path="templates/*" element={<TemplatesPage />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="reports" element={<ReportsPage />} />
          </>
        ) : null}
        <Route path="*" element={<Navigate to={`/${expected}`} replace />} />
      </Routes>
    </ConsoleShell>
  );
}

function FullState({ title, children, testId }: { title: string; children?: React.ReactNode; testId?: string }) {
  return (
    <div className="sg sg-center" data-testid={testId}>
      <div className="sg-state">
        <div className="sg-state__mark">S</div>
        <h1 className="sg-h1">{title}</h1>
        {children !== undefined ? <div className="sg-lede">{children}</div> : null}
        {testId !== undefined ? (
          <div style={{ marginTop: 16 }}>
            <Btn onClick={() => void logout()}>Sign out</Btn>
          </div>
        ) : null}
      </div>
    </div>
  );
}
