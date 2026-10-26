import { useEffect, useRef, useState } from 'react';

import { legalApi, type UpcomingLegalNotice } from '../api';
import { Btn } from '../ui';

// Privacy Notice 1.1 remediation E-6 — the in-service notice of an upcoming legal-document
// version. The backend (GET /v1/sign/legal/notices) lists the changes with a future effective
// date that concern this account and that this user has not dismissed; it decides everything.
// Each notice shown is recorded once (event SHOWN) and Dismiss records ACKNOWLEDGED — the
// in-service delivery evidence. A failed read or record never blocks the workspace.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11-25" → "25 November 2026" (calendar date, no time zone shift). */
export function noticeDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m === null) return ymd;
  const month = MONTHS[Number(m[2]) - 1];
  return month === undefined ? ymd : `${Number(m[3])} ${month} ${m[1]}`;
}

const id = (n: { key: string; version: string }) => `${n.key}@${n.version}`;

export function LegalChangeNotice({ load = legalApi.notices, record = legalApi.recordNotice }: { load?: typeof legalApi.notices; record?: typeof legalApi.recordNotice }) {
  const [notices, setNotices] = useState<UpcomingLegalNotice[]>([]);
  const shown = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    load()
      .then((r) => {
        if (live) setNotices(Array.isArray(r?.notices) ? r.notices : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => {
    for (const n of notices) {
      if (shown.current.has(id(n))) continue;
      shown.current.add(id(n));
      record(n, 'SHOWN').catch(() => undefined);
    }
  }, [notices, record]);

  if (notices.length === 0) return null;

  const dismiss = (n: UpcomingLegalNotice) => {
    setNotices((all) => all.filter((x) => id(x) !== id(n)));
    record(n, 'ACKNOWLEDGED').catch(() => undefined);
  };

  return (
    <>
      {notices.map((n) => (
        <div key={id(n)} className="sg-legal-notice" role="status" data-testid="legal-change-notice">
          <div className="sg-legal-notice__text">
            <strong>We are updating the {n.title}.</strong> Version {n.version} takes effect on {noticeDate(n.effective_date)}. Until then, version {n.current_version}{' '}
            applies.{' '}
            <a href={n.url} target="_blank" rel="noopener noreferrer">
              Read the new version
            </a>{' '}
            ·{' '}
            <a href={n.current_url} target="_blank" rel="noopener noreferrer">
              Current version
            </a>
          </div>
          <Btn size="sm" type="button" onClick={() => dismiss(n)} data-testid="legal-change-notice-dismiss" aria-label={`Dismiss the notice about the ${n.title}`}>
            Dismiss
          </Btn>
        </div>
      ))}
    </>
  );
}
