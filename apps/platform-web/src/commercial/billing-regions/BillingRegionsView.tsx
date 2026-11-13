import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Button, Checkbox, Input, Select, hasScope, type Session } from '@aramo/fe-foundation';

import { SkeletonPanel } from '../../components';
import { COMMERCIAL_PERMISSIONS as CP } from '../../components/permissions';
import { statePill } from '../commercial-model';

import { billingRegionsApi, type BillingRegion } from './billing-regions-api';
import {
  ENABLE_REFUSAL_TEXT,
  GATEWAY_LABEL,
  PRICE_TAX_MODES,
  REGIONS_INTRO,
  REGISTRATION_FIELDS,
  changeOf,
  enableBlockers,
  formErrors,
  formOf,
  onOff,
  regionLabel,
  taxModeLabel,
  type RegionForm,
} from './billing-regions-model';

import '../commercial.css';
import '../catalog/catalog.css';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10, §5, §6, ruling Q3 — Commercial › Billing
// regions. Every catalog reader (platform:catalog:read) sees each region: country, gateway, currency, selling
// entity, the master / Personal / Business switches, how prices handle GST and whether the gateway keys are
// set on the server. A catalog manager (platform:catalog:draft) edits a region and "Request change" raises a
// BILLING_REGION_CHANGE change request (Finance approves; the requester applies it from Approvals, where the
// G-3 guard is enforced). The G-3 reasons are shown here in plain words before the request is raised.

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; regions: BillingRegion[] };

function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return `billing-region-${c?.randomUUID ? c.randomUUID() : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`}`;
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.status === 403) return 'Your account can’t do this.';
  if (e instanceof ApiError) return e.message;
  return fallback;
}

export function BillingRegionsView({ session }: { readonly session: Session }) {
  const canDraft = hasScope(session, CP.catalogDraft);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchRegions = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoad({ status: 'loading' });
    try {
      const regions = await billingRegionsApi.list();
      setLoad({ status: 'ready', regions });
    } catch (e) {
      setLoad({ status: 'error', message: errorText(e, 'The billing regions couldn’t be loaded. Try again.') });
    }
  }, []);

  useEffect(() => {
    void fetchRegions();
  }, [fetchRegions]);

  const region = load.status === 'ready' ? (load.regions.find((r) => r.country === selected) ?? null) : null;

  return (
    <div className="pc-page" data-testid="billing-regions">
      <div className="pc-head">
        <h1 className="pc-h1">Billing regions</h1>
        <p className="pc-intro">{REGIONS_INTRO}</p>
      </div>
      {!canDraft ? (
        <p className="pc-viewonly" role="note">
          View only: a catalog manager requests region changes.
        </p>
      ) : null}
      <section className="pc-card" aria-label="Billing regions">
        {load.status === 'loading' ? <SkeletonPanel label="Loading billing regions…" lines={['40%', '85%', '70%']} /> : null}
        {load.status === 'error' ? (
          <div role="alert" className="pw-alert pw-alert--error pc-card__alert">
            <span>{load.message}</span>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30" onClick={() => void fetchRegions()}>
              Try again
            </Button>
          </div>
        ) : null}
        {load.status === 'ready' ? (
          <div className="pc-scroll">
            <table className="pc-table">
              <thead>
                <tr>
                  <th scope="col">Country</th>
                  <th scope="col">Gateway</th>
                  <th scope="col">Currency</th>
                  <th scope="col">Selling entity</th>
                  <th scope="col">Region</th>
                  <th scope="col">Personal</th>
                  <th scope="col">Business</th>
                  <th scope="col">GST in prices</th>
                  <th scope="col">Gateway keys</th>
                </tr>
              </thead>
              <tbody>
                {load.regions.map((r) => (
                  <tr key={r.country} data-testid={`region-${r.country}`}>
                    <td>
                      <Button unstyled type="button" className="pc-btn" aria-label={`Open ${regionLabel(r)}`} onClick={() => setSelected(r.country)}>
                        {regionLabel(r)}
                      </Button>
                    </td>
                    <td>{GATEWAY_LABEL[r.gateway] ?? r.gateway}</td>
                    <td>{r.currency}</td>
                    <td>
                      {r.selling_entity.display_name}
                      <div className="pc-row__sub">{r.selling_entity.active ? 'Active' : 'Inactive'}</div>
                    </td>
                    <td>{onOff(r.enabled)}</td>
                    <td>{onOff(r.personal_web_enabled)}</td>
                    <td>{onOff(r.business_web_enabled)}</td>
                    <td>{taxModeLabel(r.price_tax_mode)}</td>
                    <td data-testid={`gateway-configured-${r.country}`}>{r.gateway_configured ? 'Configured' : 'Not configured'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {notice !== null ? (
        <p className="pc-addons__intro" role="status">
          {notice}
        </p>
      ) : null}
      {region !== null ? (
        <RegionDetail
          key={`${region.country}:${JSON.stringify(region)}`}
          region={region}
          canDraft={canDraft}
          onEdit={() => setNotice(null)}
          onRequested={(message) => {
            setNotice(message);
            void fetchRegions(true);
          }}
        />
      ) : null}
    </div>
  );
}

function RegionDetail({ region, canDraft, onEdit, onRequested }: { region: BillingRegion; canDraft: boolean; onEdit: () => void; onRequested: (message: string) => void }) {
  const [form, setForm] = useState<RegionForm>(() => formOf(region));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = changeOf(region, form);
  const errors = formErrors(form);
  const blockers = enableBlockers(region, form);
  const set = (patch: Partial<RegionForm>) => {
    setForm({ ...form, ...patch });
    onEdit();
  };

  const request = async (): Promise<void> => {
    if (change === null) return;
    setBusy(true);
    setError(null);
    try {
      await billingRegionsApi.requestChange({ change, reason, idempotency_key: newIdempotencyKey() });
      setReason('');
      onRequested(`Change to ${regionLabel(region)} requested. Finance approves it in Approvals; you then apply it there.`);
    } catch (e) {
      setError(errorText(e, 'The change couldn’t be requested.'));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !canDraft || busy;
  return (
    <section className="pc-card pc-addons" aria-label={`${regionLabel(region)} billing region`} data-testid="region-detail">
      <div className="pc-caps pc-caps--16">{`${regionLabel(region)} · ${GATEWAY_LABEL[region.gateway] ?? region.gateway} · ${region.currency}`}</div>
      <div className="pc-diff pc-diff--list" role="table" aria-label="Current region">
        {[
          ['Region selling', onOff(region.enabled)],
          ['Personal web sales', onOff(region.personal_web_enabled)],
          ['Business web sales', onOff(region.business_web_enabled)],
          ['GST in prices', taxModeLabel(region.price_tax_mode)],
          ['Selling entity', `${region.selling_entity.display_name} (${region.selling_entity.legal_name}) · ${region.selling_entity.active ? 'Active' : 'Inactive'}`],
          ['Gateway keys', region.gateway_configured ? 'Configured on the server' : 'Not configured on the server'],
          ['Can be switched on now', region.enable_refusal === null ? 'Yes' : ENABLE_REFUSAL_TEXT[region.enable_refusal]],
        ].map(([field, value]) => (
          <div key={field} role="row" className="pc-diff__row">
            <span role="cell" className="pc-diff__field">
              {field}
            </span>
            <span role="cell" className="pc-diff__after">
              {value}
            </span>
          </div>
        ))}
      </div>
      {region.open_requests.length > 0 ? (
        <p className="pc-addons__intro" data-testid="region-open-requests">
          {`Open change requests: ${region.open_requests.map((o) => statePill(o.state).label).join(', ')}. `}
          <Link to="/commercial/approvals">Track them in Approvals</Link>
        </p>
      ) : null}

      <div className="pc-fields" data-testid="region-form">
        <div className="pc-caps pc-caps--14">Switches</div>
        {(
          [
            ['enabled', 'Region selling (master switch)'],
            ['personal_web_enabled', 'Personal web sales'],
            ['business_web_enabled', 'Business web sales'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="pc-field">
            <span className="pc-field__label">{label}</span>
            <Checkbox unstyled aria-label={label} checked={form[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked } as Partial<RegionForm>)} />
          </label>
        ))}
        <label className="pc-field">
          <span className="pc-field__label">How prices handle GST</span>
          <Select unstyled className="pc-input pc-input--editable" aria-label="How prices handle GST" value={form.price_tax_mode} disabled={disabled} onChange={(e) => set({ price_tax_mode: e.target.value as RegionForm['price_tax_mode'] })}>
            {PRICE_TAX_MODES.map((m) => (
              <option key={m} value={m}>
                {taxModeLabel(m)}
              </option>
            ))}
          </Select>
        </label>

        <div className="pc-caps pc-caps--14">Selling entity</div>
        <label className="pc-field">
          <span className="pc-field__label">Display name</span>
          <Input unstyled className="pc-input pc-input--editable" aria-label="Selling entity display name" value={form.display_name} disabled={disabled} onChange={(e) => set({ display_name: e.target.value })} />
        </label>
        <label className="pc-field">
          <span className="pc-field__label">Legal name</span>
          <Input unstyled className="pc-input pc-input--editable" aria-label="Selling entity legal name" value={form.legal_name} disabled={disabled} onChange={(e) => set({ legal_name: e.target.value })} />
        </label>
        <label className="pc-field">
          <span className="pc-field__label">Selling entity active</span>
          <Checkbox unstyled aria-label="Selling entity active" checked={form.entity_active} disabled={disabled} onChange={(e) => set({ entity_active: e.target.checked })} />
        </label>

        <div className="pc-caps pc-caps--14">Registration</div>
        <p className="pc-addons__intro">Registration numbers are recorded only: Aramo computes no tax and never shows them to a tenant.</p>
        {REGISTRATION_FIELDS.map((f) => (
          <label key={f.key} className="pc-field">
            <span className="pc-field__label">{f.label}</span>
            <Input
              unstyled
              className="pc-input pc-input--editable"
              aria-label={f.label}
              value={form.registration[f.key] ?? ''}
              disabled={disabled}
              onChange={(e) => set({ registration: { ...form.registration, [f.key]: e.target.value } })}
            />
          </label>
        ))}

        {canDraft ? (
          <label className="pc-field">
            <span className="pc-field__label">Reason for the change</span>
            <Input unstyled className="pc-input pc-input--editable" aria-label="Reason for the change" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
      </div>

      {blockers.length > 0 ? (
        <div className="pc-diff pc-diff--list" role="table" aria-label="Before the region can be switched on" data-testid="region-blockers">
          {blockers.map((b) => (
            <div key={b} role="row" className="pc-diff__row pc-diff__row--changed">
              <span role="cell" className="pc-diff__field">
                Before it can be switched on
              </span>
              <span role="cell" className="pc-diff__after">
                {b}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {[...errors, ...(error !== null ? [error] : [])].map((m) => (
        <p key={m} className="pc-alert" role="alert">
          {m}
        </p>
      ))}
      {canDraft ? (
        <div className="pc-actions">
          <Button unstyled type="button" className="pc-btn pc-btn--terra" disabled={busy || change === null || errors.length > 0 || reason.trim() === ''} onClick={() => void request()}>
            Request change
          </Button>
          {change === null ? <span className="pc-addons__intro">No changes yet.</span> : null}
        </div>
      ) : null}
    </section>
  );
}
