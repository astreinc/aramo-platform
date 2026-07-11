import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  Button,
  FormField,
  InlineAlert,
} from '@aramo/fe-foundation';

import { platformApi, ALL_CAPABILITIES } from '../platform-api';

// Provision screen — provision now, invite the owner now or later (Inc-3 PR-3.4,
// R16). The "Send owner invitation now" toggle (default on) drives invite_owner:
// on = today's provision-and-invite; off = create-now-invite-later (the owner is
// created but not emailed; the operator sends the invite from the detail page
// when the owner is ready to onboard). Either way the tenant lands PROVISIONED.
export function ProvisionTenantView() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerDisplayName, setOwnerDisplayName] = useState('');
  const [caps, setCaps] = useState<string[]>(['core', 'ats', 'portal']);
  const [inviteOwner, setInviteOwner] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleCap = (c: string): void => {
    setCaps((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi.provisionTenant({
        name: name.trim(),
        owner_email: ownerEmail.trim(),
        owner_display_name: ownerDisplayName.trim() || undefined,
        capabilities: caps,
        invite_owner: inviteOwner,
      });
      navigate(`/tenants/${res.tenant_id}`);
    } catch (err) {
      const reason =
        err instanceof ApiError
          ? (err.details?.['reason'] as string | undefined)
          : undefined;
      setError(
        err instanceof ApiError
          ? `${err.message}${reason ? ` (${reason})` : ''}`
          : 'Provisioning failed.',
      );
      setBusy(false);
    }
  };

  const disabled =
    busy || name.trim().length === 0 || ownerEmail.trim().length === 0;

  return (
    <div className="pw-page" style={{ maxWidth: 620 }}>
      <div className="pw-page__head">
        <h1 className="pw-page__title">Provision tenant</h1>
      </div>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <form className="pw-field-row" onSubmit={(e) => void submit(e)}>
        <FormField label="Tenant name">
          <input
            className="tc-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
          />
        </FormField>
        <FormField
          label="Owner email"
          helper="A business email — the owner's domain becomes the tenant's allowed domain."
        >
          <input
            className="tc-input"
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="owner@acme.corp"
          />
        </FormField>
        <FormField label="Owner display name (optional)">
          <input
            className="tc-input"
            value={ownerDisplayName}
            onChange={(e) => setOwnerDisplayName(e.target.value)}
            placeholder="Acme Owner"
          />
        </FormField>
        <FormField label="Capabilities">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {ALL_CAPABILITIES.map((c) => (
              <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={caps.includes(c)}
                  onChange={() => toggleCap(c)}
                />
                <span>{c}</span>
              </label>
            ))}
          </div>
        </FormField>
        <FormField label="Owner invitation">
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={inviteOwner}
              onChange={(e) => setInviteOwner(e.target.checked)}
            />
            <span>
              Send owner invitation now
              <span className="pw-audit__meta" style={{ display: 'block' }}>
                {inviteOwner
                  ? 'The owner receives their invitation email as soon as the tenant is provisioned.'
                  : 'The tenant is provisioned but the owner is not emailed yet — send the invite from the tenant’s detail page when the owner is ready to onboard.'}
              </span>
            </span>
          </label>
        </FormField>
        <div className="pw-actions">
          <Button variant="secondary" type="button" onClick={() => navigate('/tenants')} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={disabled}>
            {busy
              ? 'Provisioning…'
              : inviteOwner
                ? 'Provision + invite owner'
                : 'Provision (invite later)'}
          </Button>
        </div>
      </form>
    </div>
  );
}
