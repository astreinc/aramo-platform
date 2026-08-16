import { formatDate } from '../format/date';
import { formatMoney } from '../placement/commercial-format';
import { StatusPill } from '../ui';
import type { PillTone } from '../ui/pills';

import {
  GUARANTEE_TERMS_SOURCE_LABELS,
  TERMS_REMEDY_POLICY_LABELS,
  type GuaranteeTermVersionView,
  type TermsRemedyPolicy,
} from './guarantee-terms-types';

// Track 7 / T7-P5 §5.5 — one guarantee-term version row. Effective window is CALENDAR DATE
// (formatDate — never the instant formatter); money is a verbatim decimal string with its
// currency adjacent. Status is classified against an injectable `now` calendar day: an open
// version (effective_to === null) starting today-or-earlier is Current; an open version starting
// in the future is Scheduled; a closed version is History. Status uses explicit text + a pill.

type VersionStatus = 'Current' | 'Scheduled' | 'History';

function utcMidnight(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function classifyVersion(version: GuaranteeTermVersionView, nowMs: number): VersionStatus {
  const now = (() => {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  })();
  if (version.effective_to !== null) return 'History';
  return utcMidnight(version.effective_from) > now ? 'Scheduled' : 'Current';
}

const STATUS_TONE: Record<VersionStatus, PillTone> = {
  Current: 'ok',
  Scheduled: 'info',
  History: 'neutral',
};

export interface GuaranteeTermVersionRowProps {
  readonly version: GuaranteeTermVersionView;
  readonly nowMs: number;
}

export function GuaranteeTermVersionRow({ version, nowMs }: GuaranteeTermVersionRowProps) {
  const status = classifyVersion(version, nowMs);
  const policy = version.remedy_policy as TermsRemedyPolicy;
  return (
    <tr data-testid="guarantee-term-row">
      <td data-testid="term-status">
        <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>
      </td>
      <td data-testid="term-effective-from">{formatDate(version.effective_from)}</td>
      <td data-testid="term-effective-to">
        {version.effective_to === null ? 'Current' : formatDate(version.effective_to)}
      </td>
      <td data-testid="term-duration">{version.guarantee_duration_days} days</td>
      <td data-testid="term-remedy-policy">{TERMS_REMEDY_POLICY_LABELS[policy] ?? version.remedy_policy}</td>
      <td className="num" data-testid="term-exposure">
        {formatMoney(version.guarantee_exposure_amount, version.currency, '')}
      </td>
      <td data-testid="term-source">{GUARANTEE_TERMS_SOURCE_LABELS[version.source_type]}</td>
    </tr>
  );
}
