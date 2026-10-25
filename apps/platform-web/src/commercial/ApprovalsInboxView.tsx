import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, type Session } from '@aramo/fe-foundation';

import { BootstrapBanner, ChainProgress, EmptyState, Pill, SkeletonPanel, shortId } from '../components';
import { useIdentity } from '../identity/identity';
import { platformApi } from '../platform-api';

import { commercialApi, type ChangeRequest, type ChangeRequestDetail } from './commercial-api';
import { loadErrorText } from './commercial-errors';
import {
  INBOX_TABS,
  TAB_EMPTY,
  TAB_LABEL,
  actionLabel,
  chainMarks,
  expiresCell,
  personLabel,
  productLabel,
  relativeShort,
  requestRef,
  sortRows,
  statePill,
  summaryOf,
  tabRows,
  unfulfillableChains,
  type InboxTab,
  type Me,
} from './commercial-model';
import { ChangeRequestDrawer } from './ChangeRequestDrawer';
import './commercial.css';

// CCP-B1 — the Approvals inbox (CCP-UI v1.0 handoff §5.1, `/commercial/approvals`).
// Tabs: Waiting on me (the server's `eligible_for_me` set: pending and the A3
// engine's live verdict for the caller is OK), All pending, Requested by me, History
// (everything except pending and drafts). Each row: the request, tenant · product,
// the change and who asked, the chain with step state, the state, the TTL countdown
// and the policy. A row opens the change-request drawer (`?request=<id>`, so the
// drawer is linkable). All data comes from the CCP-A3 / CCP-A9 routes; tenant names
// from the existing tenant list.

/** Details are read for the rows whose chain progress or verdict needs them. */
const NEEDS_DETAIL = new Set(['PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'WITHDRAWN']);
const DETAIL_CONCURRENCY = 6;

async function readDetails(rows: readonly ChangeRequest[]): Promise<Map<string, ChangeRequestDetail>> {
  const out = new Map<string, ChangeRequestDetail>();
  const queue = rows.filter((r) => NEEDS_DETAIL.has(r.state)).map((r) => r.id);
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        out.set(id, await commercialApi.getChangeRequest(id));
      } catch {
        /* the row keeps its state-derived chain; the drawer reads it again */
      }
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, () => worker()));
  return out;
}

export interface ApprovalsInboxViewProps {
  readonly session: Session;
  /** Clock seam (tests). */
  readonly now?: () => Date;
}

export function ApprovalsInboxView({ session, now = () => new Date() }: ApprovalsInboxViewProps) {
  const identity = useIdentity();
  const me: Me = useMemo(
    () => ({ id: session.sub, name: identity.status === 'resolved' ? identity.name : null }),
    [session.sub, identity.status, identity.name],
  );
  const [params, setParams] = useSearchParams();
  const openId = params.get('request');

  const [all, setAll] = useState<ChangeRequest[] | null>(null);
  const [eligible, setEligible] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState<ReadonlyMap<string, ChangeRequestDetail>>(new Map());
  const [tenants, setTenants] = useState<ReadonlyMap<string, string>>(new Map());
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<InboxTab>('me');
  const [refused, setRefused] = useState<ChangeRequest[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [list, mine, tl] = await Promise.all([
        commercialApi.listChangeRequests(),
        commercialApi.listChangeRequests({ eligibleForMe: true }),
        platformApi.listTenants().catch(() => null),
      ]);
      setAll(list.requests);
      setTruncated(list.next_cursor !== null);
      setEligible(new Set(mine.requests.map((r) => r.id)));
      if (tl !== null) setTenants(new Map(tl.tenants.map((t) => [t.id, t.name])));
      setDetails(await readDetails(list.requests));
    } catch (e) {
      setError(loadErrorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (all === null ? [] : sortRows(tabRows(tab, all, eligible, me.id))), [all, tab, eligible, me.id]);
  const counts = useMemo(
    () => Object.fromEntries(INBOX_TABS.map((t) => [t, all === null ? null : tabRows(t, all, eligible, me.id).length])) as Record<InboxTab, number | null>,
    [all, eligible, me.id],
  );
  const chains = useMemo(() => unfulfillableChains([...details.values()], refused), [details, refused]);

  const open = (id: string | null): void => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete('request');
    else next.set('request', id);
    setParams(next, { replace: true });
  };
  const tenantName = (id: string): string | null => tenants.get(id) ?? null;
  const clock = now();

  return (
    <div className="pc-page" data-testid="approvals-inbox">
      <BootstrapBanner chains={chains} />
      <div className="pc-head">
        <h1 className="pc-h1">Approvals</h1>
        <p className="pc-intro">
          Every commercial change is a change request. It applies only after each step in its chain is signed by a different person, within the approval window set by the policy it was created under.
        </p>
      </div>
      <div role="tablist" aria-label="Inbox" className="pc-tabs">
        {INBOX_TABS.map((t) => (
          <Button
            key={t}
            unstyled
            role="tab"
            id={`pc-tab-${t}`}
            aria-selected={t === tab}
            aria-controls="pc-inbox-panel"
            className={t === tab ? 'pc-tab pc-tab--on' : 'pc-tab'}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
            <span className="pc-tab__count">{counts[t] === null ? '–' : counts[t]}</span>
          </Button>
        ))}
      </div>
      <section className="pc-card" id="pc-inbox-panel" role="tabpanel" aria-labelledby={`pc-tab-${tab}`}>
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pc-card__alert">
            {error}
          </div>
        ) : null}
        {all === null && error === null ? <SkeletonPanel label="Loading change requests…" lines={['40%', '85%', '70%', '78%']} /> : null}
        {rows.length > 0 ? (
          <div className="pc-scroll">
            <table className="pc-table">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Tenant · product</th>
                  <th scope="col">Change</th>
                  <th scope="col">Chain</th>
                  <th scope="col">State</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Policy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <InboxRow
                    key={r.id}
                    r={r}
                    me={me}
                    detail={details.get(r.id)}
                    tenant={r.tenant_id === null ? 'Platform' : (tenantName(r.tenant_id) ?? shortId(r.tenant_id))}
                    now={clock}
                    onOpen={() => open(r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {all !== null && rows.length === 0 ? (
          <div data-testid="approvals-empty">
            <EmptyState size="xl" title={TAB_EMPTY[tab].title} body={TAB_EMPTY[tab].body} />
          </div>
        ) : null}
      </section>
      {truncated ? (
        <p className="pc-note" data-testid="approvals-truncated">
          Showing the 200 most recent change requests.
        </p>
      ) : null}
      {openId !== null ? (
        <ChangeRequestDrawer
          key={openId}
          id={openId}
          me={me}
          now={now}
          tenantName={tenantName}
          initial={details.get(openId) ?? null}
          onClose={() => open(null)}
          onChanged={() => void load()}
          onBootstrapRefused={(req) => setRefused((cur) => (cur.some((x) => x.id === req.id) ? cur : [...cur, req]))}
        />
      ) : null}
    </div>
  );
}

function InboxRow({
  r,
  me,
  detail,
  tenant,
  now,
  onOpen,
}: {
  readonly r: ChangeRequest;
  readonly me: Me;
  readonly detail: ChangeRequestDetail | undefined;
  readonly tenant: string;
  readonly now: Date;
  readonly onOpen: () => void;
}) {
  const pill = statePill(r.state);
  const exp = expiresCell(r, now);
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <tr className="pc-row" tabIndex={0} aria-label={`Open change request ${requestRef(r.id)}`} onClick={onOpen} onKeyDown={onKey} data-testid={`cr-row-${r.id}`}>
      <td>
        <div className="pc-row__id" title={r.id}>
          {requestRef(r.id)}
        </div>
        <div className="pc-row__type">{actionLabel(r.action_type)}</div>
      </td>
      <td>
        <div className="pc-row__tenant">{tenant}</div>
        <div className="pc-row__sub">{productLabel(r.product_key)}</div>
      </td>
      <td className="pc-row__change">
        {summaryOf(r, me)}
        <div className="pc-row__by">
          by {personLabel(r.requested_by, me)} · {relativeShort(r.created_at, now)}
        </div>
      </td>
      <td className="pc-nowrap">
        <ChainProgress steps={chainMarks(r, detail)} />
      </td>
      <td>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </td>
      <td className={`pc-nowrap pc-row__exp pc-tone--${exp.tone}`}>{exp.text}</td>
      <td className="pc-nowrap">
        {/* The version NUMBER is not on the request (R-13): the version id, short. */}
        <span className="pc-mono12" title={`Policy version ${r.policy_version_id}`}>
          {shortId(r.policy_version_id)}
        </span>
      </td>
    </tr>
  );
}
