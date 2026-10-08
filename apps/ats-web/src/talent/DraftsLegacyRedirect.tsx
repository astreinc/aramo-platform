import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { LoadingState } from '../ui';

import { listTalentIntakeDrafts } from './talent-intake-api';
import { inProgressDrafts } from './draft-recovery';

// Talent Draft Recovery (§4) — the legacy /talent/drafts URL stays SAFE as a
// compatibility route but is never a second entry point: drafts exist →
// /talent?view=in-progress, otherwise → /talent. The standalone "Draft talents"
// page is removed.
export function DraftsLegacyRedirect(): JSX.Element {
  const [to, setTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTalentIntakeDrafts()
      .then((r) => {
        if (cancelled) return;
        setTo(inProgressDrafts(r.items).length > 0 ? '/talent?view=in-progress' : '/talent');
      })
      .catch(() => {
        // A list failure must not trap the recruiter on a dead URL — fall back to
        // the Talent home.
        if (!cancelled) setTo('/talent');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (to === null) return <LoadingState label="Opening Talent…" />;
  return <Navigate to={to} replace />;
}
