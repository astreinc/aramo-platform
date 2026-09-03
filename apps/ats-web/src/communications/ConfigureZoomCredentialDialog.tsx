import { Button, Dialog, FormField, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useState, type FormEvent } from 'react';

import { safeErrorMessage } from '../ui';

import { configureZoomCredential } from './provider-config-api';
import type { CommunicationProviderConfig, ZoomCredentialInput } from './provider-config-types';

// COMM-C1 — Zoom credential configure/update dialog. The bundle is WRITE-ONLY:
// it is posted once, encoded server-side, and stored in Secrets Manager. Nothing
// here is ever read back — the dialog opens with empty fields every time (an
// update fully replaces the stored credential). `integration:write` gates the
// affordance that opens this dialog.

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfigured: (config: CommunicationProviderConfig) => void;
  // Test seam.
  readonly configureFn?: typeof configureZoomCredential;
}

export function ConfigureZoomCredentialDialog({
  open,
  onOpenChange,
  onConfigured,
  configureFn = configureZoomCredential,
}: Props) {
  const toast = useToast();
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setAccessToken('');
    setRefreshToken('');
    setAccountId('');
    setError('');
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (saving || accessToken.trim().length === 0) return;
    setSaving(true);
    setError('');
    try {
      const bundle: ZoomCredentialInput = {
        access_token: accessToken.trim(),
        ...(refreshToken.trim() !== '' ? { refresh_token: refreshToken.trim() } : {}),
        ...(accountId.trim() !== '' ? { account_id: accountId.trim() } : {}),
      };
      const config = await configureFn(bundle);
      toast.show('Zoom credential saved.');
      onConfigured(config);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(safeErrorMessage(err, 'Could not save the credential. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const submittable = !saving && accessToken.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Configure Zoom Phone credential"
      description="Paste the Zoom OAuth credential bundle. It is stored securely and never shown again — saving a new bundle replaces the stored credential."
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
          <Button
            onClick={(ev) => onSubmit(ev)}
            disabled={!submittable}
            data-testid="zoom-credential-submit"
          >
            {saving ? 'Saving…' : 'Save credential'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} aria-label="Zoom credential form" data-testid="zoom-credential-form">
        {error !== '' && <InlineAlert variant="error">{error}</InlineAlert>}
        <FormField label="Access token">
          <input
            className="rc-input"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            data-testid="zoom-access-token-input"
            autoComplete="off"
            autoFocus
          />
        </FormField>
        <FormField label="Refresh token (optional)">
          <input
            className="rc-input"
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            data-testid="zoom-refresh-token-input"
            autoComplete="off"
          />
        </FormField>
        <FormField label="Zoom account id (optional)">
          <input
            className="rc-input"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="Provider account identity"
            data-testid="zoom-account-id-input"
            autoComplete="off"
          />
        </FormField>
      </form>
    </Dialog>
  );
}
