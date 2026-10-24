repo: astreinc/aramo-platform
branch: main

## Last sync
date: 2026-10-24T11:46:42Z

### Updated in this project
- Handoff and amendment 1 checked against the real routes, scopes and error codes
- Routes aligned to `apps/platform-web/src/App.tsx`
- Sign-in errors mapped to the existing `SignInPage` codes
- Rail collapse key set to the existing `rc-rail-collapsed`

## Screen map
| Project screen | Repo files |
|---|---|
| Platform Admin › Shell | apps/platform-web/src/shell/PlatformShell.tsx · libs/fe-foundation/src/ui/AppShell.tsx |
| Platform Admin › Routes and gating | apps/platform-web/src/App.tsx |
| Platform Admin › Sign-in / Signed out / Access denied | apps/platform-web/src/LoginPage.tsx · libs/fe-foundation/src/auth/SignInPage.tsx · libs/fe-foundation/src/auth/session.ts |
| Platform Admin › Dashboard | apps/platform-web/src/dashboard/DashboardView.tsx |
| Platform Admin › Tenants, Provision, Tenant detail | apps/platform-web/src/tenants/* · apps/platform-admin/src/app/platform/platform.controller.ts · platform-invitation.service.ts |
| Platform Admin › Sign Personal | apps/platform-web/src/personal/* · apps/platform-admin/src/app/platform/platform-personal.controller.ts |
| Platform Admin › Skills | apps/platform-web/src/skills/* |
| Platform Admin › Matching policy | apps/platform-web/src/matching/MatchingPolicyView.tsx |
| Platform Admin › Template variables | apps/platform-web/src/document-templates/TemplateVariablesView.tsx |
| Template Studio › Library | apps/platform-web/src/document-templates/DocumentTemplatesListView.tsx |
| Template Studio › Editor | apps/platform-web/src/document-templates/DocumentTemplateDetailView.tsx · libs/document-templates-web/src/dt-block-editor.tsx |
