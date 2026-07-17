import { useCallback, useEffect, useState } from 'react';
import { ApiError, Card, InlineAlert } from '@aramo/fe-foundation';

import { portalApi, type PortalNotice } from '../portal-api';

// Portal P4 P4a (§PR-1.1, D-5) — the platform-notice page. Renders the current
// versioned notice (the plain-language disclosure of how Aramo, as a platform,
// holds a cross-organization identity record and the rights a person may exercise
// against it). The bytes come from the public GET /v1/portal/notice — the same
// bytes the dormant-notice email delivers. Engagement-class: no trust fields.

export function NoticeView() {
  const [notice, setNotice] = useState<PortalNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotice(await portalApi.getNotice());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load the notice.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Your information on Aramo</h1>
      </div>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}
      {loading && <p className="po-page__lede">Loading…</p>}
      {notice !== null && (
        <Card title="Platform notice">
          {notice.text.split('\n\n').map((para, i) => (
            <p key={i} className="po-notice-para">
              {para}
            </p>
          ))}
        </Card>
      )}
    </div>
  );
}
