import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  SettingsHeadlessProvider,
  clearReturnContext,
  parseReturnContext,
  productByKey,
  readRememberedReturnContext,
  rememberReturnContext,
  trustedSignOrigin,
  type ProductAvailabilityView,
  type ReturnContext,
} from '@aramo/fe-foundation';

import { isOrgStudioPath } from '../sections';
import '../ui/org-ui.css';

// ORG-UX-1 (Directive v1.0 LOCKED §1, §3, §7.2; handoff §2/§6) — the Organization page
// frame. There are NO horizontal section tabs: every section is an item in the MAIN left
// nav (apps/home-web HomeShell), so this frame only renders the return marker and the page.
// Each page renders its own header (H1 + exact intro + actions) via OrgPageHeader.
//
// Return marker (production query form, H6): arriving from ATS or Sign Settings with
// `?from=<app>&return=<…>` remembers the originating page for this browser session and
// shows "← Back to ATS Settings" / "← Back to Sign Settings" above the page title on every
// Organization page until used. A Sign return is accepted only on the TRUSTED Sign origin
// (the backend's Sign entry) and inside /sign/settings/ (Lead Correction C). Never
// authorization, never followed automatically.
export function OrgAdminShell({ products = null }: { readonly products?: ProductAvailabilityView | null } = {}) {
  const location = useLocation();
  const signOrigin = useMemo(() => trustedSignOrigin(productByKey(products, 'sign')?.entry_path ?? null), [products]);
  const [back, setBack] = useState<ReturnContext | null>(() => readRememberedReturnContext({ signOrigin }));

  useEffect(() => {
    const ctx = parseReturnContext(location.search, { signOrigin });
    if (ctx !== null) {
      rememberReturnContext(ctx);
      setBack(ctx);
    } else {
      setBack(readRememberedReturnContext({ signOrigin }));
    }
  }, [location.search, signOrigin]);

  // TEMPLATE-STUDIO-1 S-1 — the Template Studio routes render full width (mirroring the
  // platform's pw-shell--studio): no page padding and no return marker above the Studio,
  // which draws its own header (breadcrumb back to Our templates / the gallery).
  if (isOrgStudioPath(location.pathname)) {
    return (
      <div className="ox-page ox-page--studio" data-testid="org-page">
        <SettingsHeadlessProvider>
          <Outlet />
        </SettingsHeadlessProvider>
      </div>
    );
  }

  return (
    <div className="ox-page" data-testid="org-page">
      {back !== null ? (
        <a className="ox-back" href={back.href} onClick={() => clearReturnContext()} data-testid="org-back-link">
          ← {back.label}
        </a>
      ) : null}
      <SettingsHeadlessProvider>
        <Outlet />
      </SettingsHeadlessProvider>
    </div>
  );
}

/** Link to App Home (used by sections that point back to the product tiles). */
export function AppHomeLink() {
  return <Link to="/">App Home</Link>;
}
