import { formatInstant } from '../format/date';
import { Button } from '../ui';

import { CommercialMaskedValue } from './CommercialMaskedState';
import { formatMoney } from './commercial-format';
import type { AssignmentCommercialView } from './types';

// Track 6 / T6-B4 §9/§12 — one row of the commercial revision timeline. Classification is
// computed by the parent timeline (Current / Scheduled / History) and passed in as a
// textual status; the row never re-derives "now". Compensation-masked pay/bill arrive
// omitted (undefined) and render with the non-leaking indicator (§7). Instants use the
// instant-safe formatter (DateTime amendment §6). The Cancel control appears ONLY on the
// eligible future open-tail row, decided by the parent (`canCancel`) against the §6
// mutation predicate; the server remains authoritative for stale state (§12).
export type CommercialRevisionStatus = 'current' | 'scheduled' | 'history';

const STATUS_LABELS: Record<CommercialRevisionStatus, string> = {
  current: 'Current',
  scheduled: 'Scheduled',
  history: 'History',
};

export interface CommercialRevisionRowProps {
  readonly version: AssignmentCommercialView;
  readonly status: CommercialRevisionStatus;
  readonly canCancel: boolean;
  readonly onCancel: (version: AssignmentCommercialView) => void;
}

export function CommercialRevisionRow({ version, status, canCancel, onCancel }: CommercialRevisionRowProps) {
  return (
    <li
      className="rc-defrow"
      data-testid="commercial-revision-row"
      data-status={status}
      data-revision-id={version.assignment_rate_version_id}
    >
      <div>
        <span data-testid="commercial-revision-status" className="rc-tag">
          {STATUS_LABELS[status]}
        </span>{' '}
        <time dateTime={version.effective_from} data-testid="commercial-revision-from">
          {formatInstant(version.effective_from)}
        </time>
        {' → '}
        {version.effective_to === null ? (
          'Current'
        ) : (
          <time dateTime={version.effective_to} data-testid="commercial-revision-to">
            {formatInstant(version.effective_to)}
          </time>
        )}
      </div>
      <dd className="num" data-testid="commercial-revision-pay" data-rate-period={version.rate_period}>
        Pay{' '}
        {version.pay_rate_amount === undefined ? (
          <CommercialMaskedValue data-testid="commercial-revision-pay-masked" />
        ) : (
          formatMoney(version.pay_rate_amount, version.currency, version.rate_period)
        )}
        {' · Bill '}
        {version.bill_rate_amount === undefined ? (
          <CommercialMaskedValue data-testid="commercial-revision-bill-masked" />
        ) : (
          formatMoney(version.bill_rate_amount, version.currency, version.rate_period)
        )}
      </dd>
      {version.change_reason !== null && (
        <div className="rc-muted-line" data-testid="commercial-revision-reason">
          {version.change_reason}
        </div>
      )}
      {canCancel && (
        <div className="rc-formfoot">
          <Button
            variant="secondary"
            onClick={() => onCancel(version)}
            data-testid="commercial-revision-cancel-action"
          >
            Cancel scheduled revision
          </Button>
        </div>
      )}
    </li>
  );
}
