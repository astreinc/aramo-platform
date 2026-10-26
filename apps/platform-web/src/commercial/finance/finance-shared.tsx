import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Button } from '@aramo/fe-foundation';

import { SkeletonPanel } from '../../components';
import { platformApi } from '../../platform-api';
import { subscriptionsApi } from '../subscriptions/subscriptions-api';

import { indexWorkbench, type SourceBadge, type WorkbenchIndex } from './finance-model';

// CCP-UI-V12 — the pieces the Finance, Usage and Alerts screens share: the page header, the
// loading skeleton and load error, a tenant link (Tenant › Commercial, handoff §13 "Every row
// links to its tenant"), the source badge, and the joins the reads need for display (the tenant
// slug from GET /platform/tenants, the contract reference and plan name from the CCP-B3
// workbench). A failed join only drops those labels; the screen still renders the read.

export type Load<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly value: T };

export function loadErrorText(err: unknown, what: string): string {
  if (err instanceof ApiError && err.status === 403) return `Your account can’t read ${what}.`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} couldn’t be loaded. Try again.`;
}

export function PageHead({ title, intro, aside }: { readonly title: string; readonly intro: string; readonly aside?: ReactNode }) {
  return (
    <div className="pf-head">
      <div className="pf-head__main">
        <h1 className="pc-h1">{title}</h1>
        <p className="pc-intro">{intro}</p>
      </div>
      {aside}
    </div>
  );
}

export function LoadingRows({ label }: { readonly label: string }) {
  return <SkeletonPanel label={label} lines={['40%', '85%', '70%']} />;
}

export function LoadFailed({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <div role="alert" className="pw-alert pw-alert--error pc-card__alert">
      <span>{message}</span>
      <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function Empty({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="pf-empty">
      <b>{title}</b>
      <div className="pf-empty__body">{body}</div>
    </div>
  );
}

export function TenantLink({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <Link className="pf-tenant" to={`/tenants/${encodeURIComponent(id)}?tab=commercial`}>
      {children}
    </Link>
  );
}

export function SourceTag({ badge }: { readonly badge: SourceBadge }) {
  return <span className={badge.stripe ? 'pf-src pf-src--stripe' : 'pf-src'}>{badge.label}</span>;
}

/** A request link: the change-request drawer over Approvals (B1 opens it from `?request=`). */
export function requestHref(id: string): string {
  return `/commercial/approvals?request=${encodeURIComponent(id)}`;
}

export interface Joins {
  readonly workbench: WorkbenchIndex;
  readonly slugOf: (tenantId: string) => string | null;
  readonly nameOf: (tenantId: string) => string | null;
}

const NO_JOINS: Joins = { workbench: new Map(), slugOf: () => null, nameOf: () => null };

/** The display joins (tenant slugs and names; workbench rows), loaded once per screen. */
export function useJoins(opts: { readonly workbench: boolean }): Joins {
  const [joins, setJoins] = useState<Joins>(NO_JOINS);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tenants, bench] = await Promise.all([
        platformApi.listTenants().catch(() => null),
        opts.workbench ? subscriptionsApi.workbench().catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const t = new Map((tenants?.tenants ?? []).map((x) => [x.id, x]));
      setJoins({
        workbench: indexWorkbench(bench?.rows ?? []),
        slugOf: (id) => t.get(id)?.slug ?? null,
        nameOf: (id) => t.get(id)?.name ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [opts.workbench]);
  return joins;
}
