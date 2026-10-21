import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  SettingsHeadlessProvider,
  parseReturnContext,
  readRememberedReturnContext,
  rememberReturnContext,
  clearReturnContext,
  type ReturnContext,
} from '@aramo/fe-foundation';

import { ORG_SECTIONS, orgSectionLabel, type OrgSection } from '../sections';

// Organization administration — the single shared tenant-management surface
// (accepted App Home handoff §7; frozen prototype 2026-10-18). Page header =
// the section title + "Organization · shared by every Aramo app", then the
// section tab row (Profile · Users & invitations · Users & product access ·
// Sites · Domain · Settings · Audit). Sections render embedded beneath it.
//
// Return context (Settings & navigation baseline §C): arriving from ATS or Sign
// Settings with `?from=<app>&return=<path>` remembers the originating page for
// this browser session and shows "Back to ATS Settings" / "Back to Sign
// Settings" on every Organization page until used. The value is validated on
// every read and is never authorization.
// DOC-TEMPLATE-LIB-1 T-4 — `sections`: the tabs this session can open (default: all).
export function OrgAdminShell({ sections = ORG_SECTIONS }: { readonly sections?: readonly OrgSection[] } = {}) {
  const location = useLocation();
  const [back, setBack] = useState<ReturnContext | null>(() => readRememberedReturnContext());

  useEffect(() => {
    const ctx = parseReturnContext(location.search);
    if (ctx !== null) {
      rememberReturnContext(ctx);
      setBack(ctx);
    }
  }, [location.search]);

  const sectionKey = location.pathname.replace(/^\/org\/?/, '').split('/')[0] ?? '';
  const title = orgSectionLabel(sectionKey) ?? 'Organization';

  return (
    <div className="org-page">
      {back !== null ? (
        <a className="org-back" href={back.href} onClick={() => clearReturnContext()} data-testid="org-back-link">
          ← {back.label}
        </a>
      ) : null}
      <header className="org-head">
        <h1>{title}</h1>
        <p>Organization · shared by every Aramo app</p>
      </header>
      <nav className="org-tabs" aria-label="Organization sections">
        {sections.map((s) => (
          <NavLink
            key={s.key}
            to={`/org/${s.key}`}
            className={({ isActive }) => `org-tab${isActive ? ' org-tab--on' : ''}`}
            data-testid={`org-nav-${s.key}`}
          >
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="org-body">
        <SettingsHeadlessProvider>
          <Outlet />
        </SettingsHeadlessProvider>
      </div>
    </div>
  );
}

/** Link to App Home (used by sections that point back to the product tiles). */
export function AppHomeLink() {
  return <Link to="/">App Home</Link>;
}
