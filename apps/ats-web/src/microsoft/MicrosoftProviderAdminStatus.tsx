import { useCallback, useEffect, useState } from 'react';

import { Button } from '../ui';
import { StatChip } from '../settings/components';

import { ConfigureMicrosoftDialog } from './ConfigureMicrosoftDialog';
import {
  getMicrosoftProviderStatus as defaultLoad,
  type MicrosoftConfigurationState,
  type MicrosoftProviderStatus,
} from './microsoft-api';

// COMM PART B (B5) — Microsoft 365 as a FIRST-CLASS provider row under Settings →
// Integrations → Communications. It renders the tenant CONFIGURATION state
// (Not configured / Configured / Requires attention) with a real Configure path,
// the provider capabilities, and — as a SEPARATE axis — recruiter authorization
// counts. Tenant configuration ≠ recruiter delegated authorization: a configured
// provider with zero recruiter bindings is shown truthfully, not as "unconfigured".

export interface MicrosoftProviderAdminStatusProps {
  /** integration:write — gates the Configure affordance (least-visibility). */
  readonly canWrite?: boolean;
  readonly loadFn?: () => Promise<MicrosoftProviderStatus>;
  // Test seam threaded to the dialog.
  readonly configureFn?: React.ComponentProps<typeof ConfigureMicrosoftDialog>['configureFn'];
}

const STATE_CHIP: Record<MicrosoftConfigurationState, { tone: 'ok' | 'warn' | 'muted'; label: string }> = {
  CONFIGURED: { tone: 'ok', label: 'Configured' },
  REQUIRES_ATTENTION: { tone: 'warn', label: 'Requires attention' },
  NOT_CONFIGURED: { tone: 'muted', label: 'Not configured' },
};

export function MicrosoftProviderAdminStatus(props: MicrosoftProviderAdminStatusProps): JSX.Element {
  const load = props.loadFn ?? defaultLoad;
  const canWrite = props.canWrite ?? false;
  const [status, setStatus] = useState<MicrosoftProviderStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [configureOpen, setConfigureOpen] = useState(false);

  const refresh = useCallback(() => {
    let live = true;
    load()
      .then((s) => {
        if (live) {
          setStatus(s);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => refresh(), [refresh]);

  if (loadError) {
    return (
      <div data-testid="microsoft-provider-error">Could not load the Microsoft 365 provider status.</div>
    );
  }
  if (status === null) {
    return <div data-testid="microsoft-provider-loading">Loading Microsoft 365 status…</div>;
  }

  const chip = STATE_CHIP[status.configuration_state];
  const configured = status.configuration_state !== 'NOT_CONFIGURED';
  const activeRecruiters = status.identities.active;
  const reauth = status.identities.reauth_required;

  const detail =
    status.configuration_state === 'NOT_CONFIGURED'
      ? 'Tenant-level connection — not configured.'
      : `${activeRecruiters} recruiter${activeRecruiters === 1 ? '' : 's'} connected` +
        (reauth > 0 ? ` · ${reauth} need reauthorization` : '');

  return (
    <div
      className="set-rows"
      role="group"
      aria-label="Microsoft 365"
      data-testid="microsoft-provider-status"
    >
      <div className="set-row">
        <span className="set-row__l">
          <span className="set-row__t">Microsoft 365</span>
          <span className="set-row__s" data-testid="microsoft-provider-detail">{detail}</span>
        </span>
        <span className="set-row__r" data-testid="microsoft-provider-state">
          <StatChip tone={chip.tone} dot>
            {chip.label}
          </StatChip>
        </span>
      </div>

      <div className="set-row">
        <span className="set-row__l">
          <span className="set-row__t">Capabilities</span>
          <span className="set-row__s" data-testid="microsoft-caps">
            {`Email — ${status.capabilities.email ? 'Available' : 'Unavailable'}`}
            {` · Calendar/Meeting — ${status.capabilities.meeting ? 'Available' : 'Unavailable'}`}
          </span>
        </span>
        <span className="set-row__r">
          <StatChip tone="muted">
            {`${activeRecruiters} recruiter mapping${activeRecruiters === 1 ? '' : 's'}`}
          </StatChip>
        </span>
      </div>

      {canWrite && (
        <div className="set-row">
          <span className="set-row__l" />
          <span className="set-row__r" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfigureOpen(true)}
              data-testid="microsoft-configure"
            >
              {configured ? 'Update connection' : 'Configure'}
            </Button>
          </span>
        </div>
      )}
      {!canWrite && (
        <p className="set-row__s" data-testid="microsoft-provider-readonly">
          Read-only — you do not have permission to configure this provider.
        </p>
      )}

      <ConfigureMicrosoftDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        hasSecret={status.configuration_state === 'CONFIGURED'}
        onConfigured={(s) => {
          setStatus(s);
          setConfigureOpen(false);
        }}
        {...(props.configureFn ? { configureFn: props.configureFn } : {})}
      />
    </div>
  );
}
