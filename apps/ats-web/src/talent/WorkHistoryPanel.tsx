import { useEffect, useState } from 'react';

import { Card, CardHead } from '../ui';

import { getTalentWorkHistory } from './talent-api';
import type { WorkHistoryView } from './types';

// Talent-detail Work-History card (LOCKED scope expansion — "display what we
// created"). Reads the persisted declared work history. Each row is tagged
// honestly: "From resume" (declared) until independent verification runs — the
// green "Verified" badge is a separate, later signal (ADR-0015 v1.3 §4.3),
// never applied to freshly-extracted rows.
function yearOf(iso: string | null): string | null {
  return iso !== null && iso.length >= 4 ? iso.slice(0, 4) : null;
}

function periodLabel(start: string | null, end: string | null): string {
  const s = yearOf(start);
  const e = yearOf(end);
  if (s === null && e === null) return '';
  if (e === null) return `${s ?? ''} – present`;
  return `${s ?? ''} – ${e}`;
}

export function WorkHistoryPanel({ talentId }: { readonly talentId: string }) {
  const [rows, setRows] = useState<readonly WorkHistoryView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    getTalentWorkHistory(talentId)
      .then((res) => {
        if (!cancelled) setRows(res.work_history);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  return (
    <Card>
      <CardHead title="Work history" />
      {failed ? <p className="rc-muted-line rc-mt-8">Couldn’t load work history.</p> : null}
      {rows === null && !failed ? <p className="rc-muted-line rc-mt-8">Loading…</p> : null}
      {rows !== null && rows.length === 0 ? (
        <p className="rc-muted-line rc-mt-8">
          No work history yet — it’s captured from the résumé at creation.
        </p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul className="rc-whd-list">
          {rows.map((r) => {
            const period = periodLabel(r.start_date, r.end_date);
            return (
              <li key={r.id} className="rc-whd-item">
                <div className="rc-whd-item__hd">
                  <span className="rc-whd-item__role">{r.role_title}</span>
                  <span
                    className={`rc-whd-badge${r.verified ? ' rc-whd-badge--verified' : ''}`}
                  >
                    {r.verified ? 'Verified' : 'From resume'}
                  </span>
                </div>
                <div className="rc-whd-item__sub">
                  {r.employer_name}
                  {period !== '' ? ` · ${period}` : ''}
                </div>
                {r.description !== null && r.description !== '' ? (
                  <p className="rc-whd-item__desc">{r.description}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
