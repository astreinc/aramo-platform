import { Button, Dialog, FormField, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useState, type FormEvent } from 'react';

import { safeErrorMessage } from '../ui';

import { configureMicrosoft, type MicrosoftProviderStatus } from './microsoft-api';

// COMM PART B — Microsoft 365 tenant establishment dialog. The client secret is
// WRITE-ONLY: it is posted once and never read back (fields open empty every
// time). Non-secret config (application/client id + authority tenant) is stored on
// the governed IntegrationConnection; the secret goes only to Secrets Manager.
// `integration:write` gates the affordance that opens this dialog. The redirect
// (callback) URI is environment configuration, shown read-only for Azure setup.

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfigured: (status: MicrosoftProviderStatus) => void;
  /** Whether a usable secret already exists (an update may omit the secret). */
  readonly hasSecret: boolean;
  /** The callback URI to register in Azure (display-only; never edited here). */
  readonly redirectUri?: string;
  // Test seam.
  readonly configureFn?: typeof configureMicrosoft;
}

export function ConfigureMicrosoftDialog({
  open,
  onOpenChange,
  onConfigured,
  hasSecret,
  redirectUri,
  configureFn = configureMicrosoft,
}: Props) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [authorityTenant, setAuthorityTenant] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setClientId('');
    setAuthorityTenant('');
    setClientSecret('');
    setError('');
  };

  // A brand-new connection must include the secret; an update may keep the stored one.
  const secretRequired = !hasSecret;
  const submittable =
    !saving &&
    clientId.trim().length > 0 &&
    authorityTenant.trim().length > 0 &&
    (!secretRequired || clientSecret.trim().length > 0);

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!submittable) return;
    setSaving(true);
    setError('');
    try {
      const status = await configureFn({
        client_id: clientId.trim(),
        authority_tenant: authorityTenant.trim(),
        ...(clientSecret.trim() !== '' ? { client_secret: clientSecret.trim() } : {}),
      });
      toast.show('Microsoft 365 connection saved.');
      onConfigured(status);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(safeErrorMessage(err, 'Could not save the Microsoft 365 connection. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Configure Microsoft 365"
      description="Connect your tenant's Microsoft 365 (Entra) app registration. The client secret is stored securely and never shown again — saving a new secret replaces the stored one. Recruiters connect their own mailbox separately after this."
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={(ev) => onSubmit(ev)} disabled={!submittable} data-testid="microsoft-configure-submit">
            {saving ? 'Saving…' : 'Save connection'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} aria-label="Microsoft 365 connection form" data-testid="microsoft-configure-form">
        {error !== '' && <InlineAlert variant="error">{error}</InlineAlert>}
        {redirectUri !== undefined && redirectUri !== '' && (
          <FormField label="Redirect (callback) URI — register this in Azure">
            <input className="rc-input" value={redirectUri} readOnly data-testid="microsoft-redirect-uri" />
          </FormField>
        )}
        <FormField label="Application (client) ID">
          <input
            className="rc-input"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            data-testid="microsoft-client-id-input"
            autoComplete="off"
            autoFocus
          />
        </FormField>
        <FormField label="Directory (authority) tenant">
          <input
            className="rc-input"
            value={authorityTenant}
            onChange={(e) => setAuthorityTenant(e.target.value)}
            placeholder="tenant id or domain (e.g. contoso.onmicrosoft.com)"
            data-testid="microsoft-authority-tenant-input"
            autoComplete="off"
          />
        </FormField>
        <FormField label={hasSecret ? 'Client secret (leave blank to keep the stored secret)' : 'Client secret'}>
          <input
            className="rc-input"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            data-testid="microsoft-client-secret-input"
            autoComplete="off"
          />
        </FormField>
      </form>
    </Dialog>
  );
}
