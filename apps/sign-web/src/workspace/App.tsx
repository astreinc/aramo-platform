import { Navigate, Route, Routes } from 'react-router-dom';
import { AUTH_PRODUCTS, RouteGuard, SignedOut, ToastProvider, logout, useSession } from '@aramo/fe-foundation';

import { Dashboard } from './pages/Dashboard';
import { EnvelopeActivity, EnvelopeDetail } from './pages/EnvelopeDetail';
import { EnvelopeList } from './pages/EnvelopeList';
import { EnvelopeSent, EnvelopeWizard, NewEnvelope } from './pages/EnvelopeWizard';
import { BillingPanel } from './pages/Billing';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';
import { ActivityPage, ContactsPage, DocumentsPage, ReportsPage } from './pages/WorkspacePages';
import { TemplatesPage } from './pages/Templates';
import { LoginPage } from './routes/LoginPage';
import { SignupPage, SignupVerifyPage } from './routes/SignupPage';
import { PersonalSignupPage } from './routes/PersonalSignupPage';
import { ReportPage } from './routes/ReportPage';
import { DomainDelegatePage } from './routes/DomainDelegatePage';
import { DomainCard } from './pages/DomainCard';
import { ConsoleShell } from './shell';
import { Btn } from './ui';
import { WorkspaceProvider, useSenderContext, type Workspace } from './workspace';
import type { SenderContext } from './api';

// The Aramo Sign WORKSPACE — the signed-in zone of the one Sign application on
// sign.aramo.ai (Sign Unified Product S-2; directive §4.1, amending the Lead Host
// & Workspace Ruling v1.0), one workspace for BUSINESS and PERSONAL accounts:
//   /            resolves the workspace from the BACKEND context, then redirects
//   /sign/*      BUSINESS organization workspace
//   /personal/*  PERSONAL workspace (sending not enabled)
//   /login       login landing (?error=<CODE>), /signed-out public landing
//   /signup      public self-service BUSINESS signup (+ /signup/verify; dark)
//   /signup/personal  public Personal (Free) signup; /report  "Report this email"
// The route prefix never authorizes: the backend decides tenant, kind, entitlement
// and every action; a mismatched prefix is redirected to the backend's workspace.
// Guest signing (/s/:token, /d/:token) is a separate zone that never loads this
// code (src/zones.ts).

export function App({ contextLoader }: { contextLoader?: () => Promise<SenderContext> }) {
  const state = useSession();
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signed-out" element={<SignedOut offerAccountSwitch product={AUTH_PRODUCTS.sign} />} />
        {/* Aramo Sign launch — public self-service signup (session-less). */}
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/signup/verify" element={<SignupVerifyPage />} />
        {/* Aramo Sign Personal (Free) — public Personal signup (dark while the mode is off)
            and "Report this email" from a Personal sender's signing email (no sign-in). */}
        <Route path="/signup/personal" element={<PersonalSignupPage />} />
        <Route path="/report" element={<ReportPage />} />
        {/* Domain-Enforcement P3 §5 — the IT administrator's delegate link
            (session-less; the token is in the URL fragment). */}
        <Route path="/domain-verification" element={<DomainDelegatePage />} />
        {/* Sign Unified Product S-7 — "Waiting for me": a recipient right, open to
            any signed-in Sign user (with or without a Sign role). */}
        <Route
          path="/inbox"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? <InboxPage /> : null}
            </RouteGuard>
          }
        />
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
  // Aramo Sign launch (Journey A) — the organization owner of an entitled tenant
  // who holds no Sign access yet sets the organization up here. ROLES-1 PR-2
  // (§3.4): plan management is sign:billing:manage only (the organization owner).
  if (ctx.status === 'no_access' && scopes.includes('sign:billing:manage'))
    return (
      <div className="sg sg-center" data-testid="state-setup">
        <div className="sg-state" style={{ maxWidth: 760, textAlign: 'left' }}>
          <div className="sg-state__mark">S</div>
          <h1 className="sg-h1">Set up Aramo Sign for your organization</h1>
          <div className="sg-lede" style={{ marginBottom: 16 }}>
            Choose a plan to start sending documents for signature. As the organization owner, you manage the plan.
          </div>
          {/* Domain-Enforcement P3 §4 — a new subscription needs the organization's
              verified (authoritative) email domain, and this owner cannot reach
              Settings yet, so the Domain card sits above the plans. */}
          {scopes.includes('tenant:admin:domain') ? (
            <div style={{ marginBottom: 16 }}>
              <DomainCard />
            </div>
          ) : null}
          <BillingPanel onSending={ctx.retry} />
          <div style={{ marginTop: 16 }}>
            <Btn onClick={() => void logout()}>Sign out</Btn>
          </div>
        </div>
      </div>
    );
  if (ctx.status === 'no_access')
    return (
      <FullState title="You don’t have access to Aramo Sign" testId="state-no-access">
        Your organization has Aramo Sign, but your account has no Sign role. Ask an organization admin for access.
        <div style={{ marginTop: 14 }}>
          <a href="/inbox">Documents sent to you for signature</a>
        </div>
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
        <Route path="settings/:section" element={<SettingsPage scopes={scopes} />} />
        {/* S-7 — documents sent TO this user, inside the workspace shell. */}
        <Route path="inbox" element={<InboxPage embedded />} />
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
