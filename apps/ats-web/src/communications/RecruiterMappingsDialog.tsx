import { Button, Dialog, FormField, InlineAlert, Switch, useToast } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { EmptyState, ErrorState, LoadingState, safeErrorMessage } from '../ui';

import {
  listCommunicationProviderIdentities,
  upsertCommunicationProviderIdentity,
} from './provider-config-api';
import type { CommunicationProviderIdentity } from './types';

// COMM-C1 — recruiter↔provider identity mapping administration (Settings →
// Integrations → Communications). Reuses the existing provider-identity admin
// routes (integration:read to list, integration:write to map/rebind). No second
// mapping model. `sms_enabled` is METADATA only in this slice — there is no SMS
// execution path, so the toggle records intent but grants no send capability.

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly canWrite: boolean;
  readonly onChanged: () => void;
  // Test seams.
  readonly listFn?: typeof listCommunicationProviderIdentities;
  readonly upsertFn?: typeof upsertCommunicationProviderIdentity;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly CommunicationProviderIdentity[] }
  | { status: 'error' };

export function RecruiterMappingsDialog({
  open,
  onOpenChange,
  canWrite,
  onChanged,
  listFn = listCommunicationProviderIdentities,
  upsertFn = upsertCommunicationProviderIdentity,
}: Props) {
  const toast = useToast();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  const [recruiterId, setRecruiterId] = useState('');
  const [providerUserId, setProviderUserId] = useState('');
  const [extension, setExtension] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'loading' });
    listFn()
      .then((items) => {
        if (!cancelled) setState({ status: 'ready', items });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, listFn, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const resetForm = () => {
    setRecruiterId('');
    setProviderUserId('');
    setExtension('');
    setVoiceEnabled(true);
    setSmsEnabled(false);
    setError('');
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (saving || recruiterId.trim() === '' || providerUserId.trim() === '') return;
    setSaving(true);
    setError('');
    try {
      await upsertFn(recruiterId.trim(), {
        provider_user_id: providerUserId.trim(),
        ...(extension.trim() !== '' ? { extension: extension.trim() } : {}),
        voice_enabled: voiceEnabled,
        sms_enabled: smsEnabled,
      });
      toast.show('Recruiter mapping saved.');
      resetForm();
      refresh();
      onChanged();
    } catch (err: unknown) {
      setError(safeErrorMessage(err, 'Could not save the mapping. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const submittable = !saving && recruiterId.trim() !== '' && providerUserId.trim() !== '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
      title="Recruiter provider mappings"
      description="Map each recruiter to their Zoom Phone user/extension. Mappings never expose another tenant's identities."
      size="lg"
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <div data-testid="recruiter-mappings">
        {state.status === 'loading' && <LoadingState label="Loading mappings…" />}
        {state.status === 'error' && (
          <ErrorState message="Could not load recruiter mappings." onRetry={refresh} />
        )}
        {state.status === 'ready' && state.items.length === 0 && (
          <EmptyState message="No recruiter mappings yet." />
        )}
        {state.status === 'ready' && state.items.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="recruiter-mappings-list">
            {state.items.map((m) => (
              <li key={m.recruiter_id} className="set-row" data-testid={`recruiter-mapping-${m.recruiter_id}`}>
                <span className="set-row__l">
                  <span className="set-row__t">{m.recruiter_id}</span>
                  <span className="set-row__s">
                    {m.provider_user_id}
                    {m.extension != null ? ` · ext ${m.extension}` : ''} · {m.status}
                    {m.voice_enabled ? ' · voice' : ''}
                    {m.sms_enabled ? ' · sms (metadata)' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <form onSubmit={onSubmit} aria-label="Recruiter mapping form" data-testid="recruiter-mapping-form" style={{ marginTop: '1rem' }}>
            {error !== '' && <InlineAlert variant="error">{error}</InlineAlert>}
            <FormField label="Recruiter id">
              <input
                className="rc-input"
                value={recruiterId}
                onChange={(e) => setRecruiterId(e.target.value)}
                placeholder="Recruiter user id (UUID)"
                data-testid="mapping-recruiter-id-input"
              />
            </FormField>
            <FormField label="Provider user id">
              <input
                className="rc-input"
                value={providerUserId}
                onChange={(e) => setProviderUserId(e.target.value)}
                data-testid="mapping-provider-user-id-input"
                autoComplete="off"
              />
            </FormField>
            <FormField label="Extension (optional)">
              <input
                className="rc-input"
                value={extension}
                onChange={(e) => setExtension(e.target.value)}
                data-testid="mapping-extension-input"
                autoComplete="off"
              />
            </FormField>
            <div className="set-row">
              <span className="set-row__l">
                <span className="set-row__t">Voice enabled</span>
              </span>
              <span className="set-row__r">
                <Switch checked={voiceEnabled} onCheckedChange={setVoiceEnabled} data-testid="mapping-voice-toggle" />
              </span>
            </div>
            <div className="set-row">
              <span className="set-row__l">
                <span className="set-row__t">SMS enabled (metadata only)</span>
                <span className="set-row__s">Recorded as intent; SMS send is not available in this release.</span>
              </span>
              <span className="set-row__r">
                <Switch checked={smsEnabled} onCheckedChange={setSmsEnabled} data-testid="mapping-sms-toggle" />
              </span>
            </div>
            <Button onClick={(ev) => onSubmit(ev)} disabled={!submittable} data-testid="mapping-submit">
              {saving ? 'Saving…' : 'Save mapping'}
            </Button>
          </form>
        )}
      </div>
    </Dialog>
  );
}
