import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Checkbox, Input, Select, useOptionalToast } from '@aramo/fe-foundation';

import { SkeletonPanel } from '../components';
import { platformApi } from '../platform-api';

import { governanceApi, type AuditEvent, type AuditFilters } from './governance-api';
import {
  downloadCsv,
  eventDetail,
  eventLabel,
  fmtUtc,
  personName,
  PRODUCT_LABEL,
  roleLabel,
  shortEventId,
  shortRequestId,
} from './governance-model';
import { governanceErrorText } from './governance-errors';
import './governance.css';

// CCP-B5 (handoff §5.7) — /commercial/audit, the append-only commercial audit explorer
// (platform:commercial:audit:read: platform_owner, finance_admin, read_only_auditor). No row
// actions: entries can't be edited or deleted. Export CSV runs the server-side export
// (POST /platform/commercial/audit-events/export), which is READ-ONLY and is itself recorded
// as a COMMERCIAL_AUDIT_EXPORTED event (pre-execution C-5).
//
// The actor, tenant, product, event-type and exception filters are server filters; the
// "Change request" text matches the request id (short or full) over the loaded rows, and an
// export by request needs that text to name exactly one request.

const PAGE = 200;
const MAX_PAGES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AuditExplorerView() {
  const toast = useOptionalToast();
  const [actor, setActor] = useState('all');
  const [tenant, setTenant] = useState('all');
  const [product, setProduct] = useState('all');
  const [type, setType] = useState('all');
  const [cr, setCr] = useState('');
  const [exc, setExc] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [all, setAll] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);

  const filters: AuditFilters = useMemo(
    () => ({
      ...(actor !== 'all' ? { actor_id: actor } : {}),
      ...(tenant !== 'all' ? { tenant_id: tenant } : {}),
      ...(product !== 'all' ? { product_key: product } : {}),
      ...(type !== 'all' ? { event_type: type } : {}),
      ...(exc ? { exception_only: true } : {}),
    }),
    [actor, tenant, product, type, exc],
  );

  const fetchAll = useCallback(async (f: AuditFilters): Promise<AuditEvent[]> => {
    const out: AuditEvent[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await governanceApi.listAuditEvents({
        ...f,
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.events);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return out;
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [rows, everything] = await Promise.all([
        fetchAll(filters),
        Object.keys(filters).length === 0 ? null : fetchAll({}),
      ]);
      setEvents(rows);
      setAll(everything ?? rows);
      setError(null);
    } catch (e) {
      setError(governanceErrorText(e));
      setEvents([]);
    }
  }, [fetchAll, filters]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    governanceApi.listOperators().then(
      (r) => setNames(new Map(r.operators.map((o) => [o.user_id, personName(o, o.user_id)]))),
      () => undefined,
    );
    platformApi.listTenants().then(
      (r) => setTenants(r.tenants.map((t) => ({ id: t.id, name: t.name }))),
      () => undefined,
    );
  }, []);

  const nameOf = useCallback((id: string) => names.get(id) ?? id, [names]);
  const tenantName = useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);
  const needle = cr.trim().toLowerCase();
  const rows = (events ?? []).filter(
    (e) =>
      needle === '' ||
      (e.change_request_id !== null &&
        (e.change_request_id.toLowerCase().includes(needle) ||
          shortRequestId(e.change_request_id).toLowerCase().includes(needle))),
  );
  const crIds = [
    ...new Set(rows.map((e) => e.change_request_id).filter((x): x is string => x !== null)),
  ];
  const crForExport =
    needle === ''
      ? null
      : UUID.test(cr.trim())
        ? cr.trim()
        : crIds.length === 1
          ? (crIds[0] as string)
          : undefined;
  const actorOpts = [...new Set(all.map((e) => e.actor_id).filter((x): x is string => x !== null))];
  const typeOpts = [...new Set(all.map((e) => e.event_type))];

  const exportCsv = async (): Promise<void> => {
    if (crForExport === undefined) return;
    setExporting(true);
    try {
      const out = await governanceApi.exportAudit({
        ...filters,
        ...(crForExport !== null ? { change_request_id: crForExport } : {}),
      });
      downloadCsv(out.filename, out.csv);
      toast.show(`Exported ${out.row_count} events. The export is itself recorded.`);
      await reload();
    } catch (e) {
      toast.show(governanceErrorText(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pw-gov" data-testid="commercial-audit">
      <div className="pw-gov-head pw-gov-head--row">
        <div className="pw-gov-head__text">
          <h1 className="pw-gov-title">Commercial audit</h1>
          <p className="pw-gov-intro">
            An append-only record of every commercial event. Entries can&apos;t be edited or deleted
            — corrections are new events.
          </p>
        </div>
        <Button
          unstyled
          className="pw-gov-btn pw-gov-btn--38 pw-gov-btn--secondary"
          disabled={exporting || crForExport === undefined}
          title={
            crForExport === undefined
              ? 'Enter a change request that names exactly one request to export by request.'
              : undefined
          }
          onClick={() => void exportCsv()}
        >
          Export CSV ({rows.length})
        </Button>
      </div>
      <div className="pw-aud-filters">
        <Select
          unstyled
          className="pw-aud-select"
          aria-label="Actor"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          <option value="all">All actors</option>
          {actorOpts.map((a) => (
            <option key={a} value={a}>
              {nameOf(a)}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          className="pw-aud-select"
          aria-label="Tenant"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
        >
          <option value="all">All tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          className="pw-aud-select"
          aria-label="Product"
          value={product}
          onChange={(e) => setProduct(e.target.value)}
        >
          <option value="all">All products</option>
          {Object.entries(PRODUCT_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          unstyled
          className="pw-aud-select"
          aria-label="Event type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">All event types</option>
          {typeOpts.map((k) => (
            <option key={k} value={k}>
              {eventLabel(k)}
            </option>
          ))}
        </Select>
        <Input
          unstyled
          className="pw-aud-cr"
          aria-label="Change request"
          placeholder="Change request, e.g. CR-1041"
          value={cr}
          onChange={(e) => setCr(e.target.value)}
        />
        <label className="pw-aud-exc">
          <Checkbox
            unstyled
            className="pw-aud-exc__box"
            checked={exc}
            onChange={(e) => setExc(e.target.checked)}
          />
          Exceptions only
        </label>
      </div>
      <section className="pw-gov-card" aria-label="Commercial audit events">
        {events === null ? (
          <SkeletonPanel lines={['60%', '85%', '70%']} label="Loading audit events…" />
        ) : null}
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-aud-error">
            {error}
          </div>
        ) : null}
        {events !== null && rows.length > 0 ? (
          <div className="pw-gov-scroll">
            <table className="pw-gov-table pw-aud-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Actor · roles at the time</th>
                  <th>Tenant · product</th>
                  <th>Request</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const prod =
                    typeof e.payload['product_key'] === 'string'
                      ? (PRODUCT_LABEL[e.payload['product_key'] as string] ??
                        (e.payload['product_key'] as string))
                      : '';
                  const actorName = e.actor_id === null ? 'System' : nameOf(e.actor_id);
                  const roles =
                    e.actor_role_keys.length > 0
                      ? e.actor_role_keys.map(roleLabel).join(', ')
                      : e.actor_type === 'system'
                        ? 'System'
                        : '—';
                  return (
                    <tr key={e.id}>
                      <td className="pw-aud-time">
                        <div className="pw-aud-mono">{fmtUtc(e.created_at)}</div>
                        <div className="pw-aud-mono pw-aud-faint">{shortEventId(e.id)}</div>
                      </td>
                      <td>
                        <div className="pw-aud-event">{eventLabel(e.event_type)}</div>
                        {e.is_exception ? <span className="pw-aud-exc-tag">EXCEPTION</span> : null}
                      </td>
                      <td>
                        {actorName}
                        <div className="pw-aud-sub">{roles}</div>
                      </td>
                      <td>
                        {e.tenant_id === null ? '—' : (tenantName.get(e.tenant_id) ?? e.tenant_id)}
                        <div className="pw-aud-sub">{prod}</div>
                      </td>
                      <td className="pw-aud-cr-cell">
                        {e.change_request_id !== null ? (
                          <Link
                            className="pw-aud-cr-link"
                            to={`/commercial/approvals?request=${e.change_request_id}`}
                          >
                            {shortRequestId(e.change_request_id)}
                          </Link>
                        ) : null}
                      </td>
                      <td className="pw-aud-detail">{eventDetail(e, nameOf)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {events !== null && rows.length === 0 && error === null ? (
          <div className="pw-gov-empty">
            <b>No events match these filters</b>
            <div className="pw-gov-empty__body">
              The log itself is never empty or edited — try a wider filter.
            </div>
          </div>
        ) : null}
        <div className="pw-aud-foot">Append-only · {all.length} events · newest first</div>
      </section>
    </div>
  );
}
