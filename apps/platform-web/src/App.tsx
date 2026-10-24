import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RouteGuard, ToastProvider, hasScope, useSession, type Session } from '@aramo/fe-foundation';

import { LoginPage, PlatformSignedOut } from './LoginPage';
import { PlatformShell } from './shell/PlatformShell';
import { PlatformAccessDenied } from './shell/PlatformAccessDenied';
import { PLATFORM_PERMISSIONS as P } from './components/permissions';
import { DashboardView } from './dashboard/DashboardView';
import { TenantsListView } from './tenants/TenantsListView';
import { TenantDetailView } from './tenants/TenantDetailView';
import { ProvisionTenantView } from './tenants/ProvisionTenantView';
import { SkillsRegistryView } from './skills/SkillsRegistryView';
import { SkillDetailView } from './skills/SkillDetailView';
import { ReviewQueueView } from './skills/ReviewQueueView';
import { ProposalsListView } from './skills/ProposalsListView';
import { ProposalDetailView } from './skills/ProposalDetailView';
import { DocumentTemplatesListView } from './document-templates/DocumentTemplatesListView';
import { DocumentTemplateDetailView } from './document-templates/DocumentTemplateDetailView';
import { TemplateVariablesView } from './document-templates/TemplateVariablesView';
import { MatchingPolicyView } from './matching/MatchingPolicyView';
import { PersonalReviewView } from './personal/PersonalReviewView';
import { PersonalInviteView } from './personal/PersonalInviteView';
import { PlatformAdminsView } from './admins/PlatformAdminsView';

// The platform console app. RouteGuard handles only loading, unauthenticated
// (→ sign-in) and the TENANT_ACCESS_DENIED wrong-account redirect — it no longer
// receives `requireScope` (PLATFORM-UX-1 directive R-5). Every permission gate —
// the console entry (platform:tenant:read) and each route's own scope — renders
// the in-shell AccessDenied (handoff §3.5) INSIDE PlatformShell, with the
// signed-in identity and the account-switch / sign-out actions, and never
// redirects. Server-side enforcement stays authoritative.
export function App() {
  const state = useSession();
  const location = useLocation();

  // Inc-3 PR-3.5 (Workstream B) — /login is the SESSION-LESS landing the
  // auth-service callback navigates to on a login failure (?error=<CODE>). It
  // must render OUTSIDE RouteGuard (an unauthenticated user is exactly who lands
  // here) — otherwise RouteGuard would bounce them straight back to the IdP and
  // swallow the error. Short-circuit before the guard; same param/pattern as
  // ats-web.
  if (location.pathname === '/login') {
    return (
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
    );
  }

  // T2-E1-HF3 — the PUBLIC signed-out landing. Same short-circuit-before-guard
  // pattern as /login: the Cognito logout returns the browser here
  // (deriveSignoutRedirect → /signed-out); it must render session-less and NOT
  // re-enter RouteGuard (which would silently re-authenticate via SSO).
  if (location.pathname === '/signed-out') {
    return (
      <ToastProvider>
        <PlatformSignedOut />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <RouteGuard sessionStateOverride={state}>
        {state.status === 'authenticated' ? <PlatformConsole session={state.session} /> : null}
      </RouteGuard>
    </ToastProvider>
  );
}

/** The authenticated console: the shell, the entry gate and every routed screen. */
export function PlatformConsole({ session }: { readonly session: Session }) {
  // Entry gate (handoff §2): without platform:tenant:read every route shows the
  // in-shell access-denied state for the whole console.
  if (!hasScope(session, P.tenantRead)) {
    return (
      <PlatformShell session={session}>
        <PlatformAccessDenied session={session} scope={P.tenantRead} />
      </PlatformShell>
    );
  }

  // A per-route gate: the screen, or the in-shell access-denied state naming the
  // page and its missing permission (with "Back to dashboard").
  const gate = (scope: string, page: string, element: ReactElement): ReactElement =>
    hasScope(session, scope) ? element : <PlatformAccessDenied session={session} scope={scope} page={page} />;

  return (
    <PlatformShell session={session}>
      <Routes>
        {/* Inc-3 PR-3.8 — the operator dashboard is the default post-login
            screen; the tenant list is one click away in the rail. */}
        <Route path="/" element={<DashboardView />} />
        <Route path="/tenants" element={<TenantsListView />} />
        <Route path="/tenants/new" element={<ProvisionTenantView />} />
        {/* The detail view keeps reading its tab from `?tab=` (directive R-12). */}
        <Route path="/tenants/:id" element={<TenantDetailView session={session} />} />
        {/* SKILL-TAX-1F-C1/C2 — the platform skill governance console, gated on
            platform:skill:read; manage controls gate on platform:skill:manage
            inside the views. Static paths precede /skills/:id so react-router
            ranks them ahead of the dynamic detail route. */}
        <Route
          path="/skills"
          element={gate(P.skillRead, 'Registry', <SkillsRegistryView session={session} />)}
        />
        <Route
          path="/skills/review-queue"
          element={gate(P.skillRead, 'Review queue', <ReviewQueueView session={session} />)}
        />
        <Route path="/skills/proposals" element={gate(P.skillRead, 'Proposals', <ProposalsListView />)} />
        <Route
          path="/skills/proposals/:id"
          element={gate(P.skillRead, 'Proposals', <ProposalDetailView session={session} />)}
        />
        <Route path="/skills/:id" element={gate(P.skillRead, 'Registry', <SkillDetailView session={session} />)} />
        {/* DOC-TEMPLATE-LIB-1 T-2 (§8.1) — Aramo default document templates + the
            template variable catalog, gated on platform:document_template:read;
            write controls gate on platform:document_template:manage inside. */}
        <Route
          path="/document-templates"
          element={gate(P.documentTemplateRead, 'Document templates', <DocumentTemplatesListView session={session} />)}
        />
        <Route
          path="/document-templates/:id"
          element={gate(P.documentTemplateRead, 'Document templates', <DocumentTemplateDetailView session={session} />)}
        />
        <Route
          path="/template-variables"
          element={gate(P.documentTemplateRead, 'Template variables', <TemplateVariablesView session={session} />)}
        />
        {/* ATI-SEP-1 A2 A-c (P1) — the platform-owned matching calibration, gated
            on platform:matching_policy:read; new-version + activate gate on
            platform:matching_policy:write inside the view. */}
        <Route
          path="/matching"
          element={gate(P.matchingPolicyRead, 'Matching policy', <MatchingPolicyView session={session} />)}
        />
        {/* Aramo Sign Personal (Free) §6.5/§10 — the review queue and pilot
            invites; the API guards them with platform:tenant:lifecycle:manage
            (authoritative, amendment 3), mirrored here. */}
        <Route
          path="/personal-review"
          element={gate(P.tenantLifecycleManage, 'Review queue', <PersonalReviewView />)}
        />
        <Route
          path="/personal-invites"
          element={gate(P.tenantLifecycleManage, 'Pilot invites', <PersonalInviteView />)}
        />
        {/* PLATFORM-UX-1 (directive R-12) — Platform admins at /admins (never under
            /platform/, which nginx proxies to the backend). */}
        <Route path="/admins" element={gate(P.adminInvite, 'Platform admins', <PlatformAdminsView />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PlatformShell>
  );
}
