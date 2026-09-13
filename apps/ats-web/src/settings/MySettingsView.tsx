import { PageHeader } from '../ui';
import { MicrosoftAccountConnection } from '../microsoft/MicrosoftAccountConnection';

// My Settings — the PERSONAL settings area, available to every signed-in user
// from the top-right account menu (enterprise pattern). Distinct from the admin
// "Settings" (tenant/workspace administration, role-gated). Rendered in the
// normal recruiter chrome (NOT the admin SettingsShell), and NOT behind
// AdminGate — a recruiter reaches their own settings here. First section is
// Connected accounts (the per-user Microsoft mailbox connect); Notifications and
// Profile are placeholders for the next personal-settings slices.

export function MySettingsView(): JSX.Element {
  return (
    <section className="rc-mysettings" data-testid="my-settings">
      <PageHeader
        title="My Settings"
        description="Personal preferences for your own account. Workspace and tenant configuration lives in Settings (admin only)."
      />

      <div className="my-card" data-testid="my-settings-connected-accounts">
        <div className="my-card__t">Connected accounts</div>
        <div className="my-card__sub">
          Connect your own mailbox and calendar so email and meeting evidence is
          sent as you. Tenant-level providers are configured by admins under
          Settings → Integrations.
        </div>
        <MicrosoftAccountConnection />
      </div>

      <div className="my-card">
        <div className="my-card__t">Notifications</div>
        <div className="my-card__sub my-card__sub--last">
          How you’re notified about tasks, submittals and pipeline changes.
          Coming soon.
        </div>
      </div>

      <div className="my-card">
        <div className="my-card__t">Profile</div>
        <div className="my-card__sub my-card__sub--last">
          Your display name and personal details. Coming soon.
        </div>
      </div>
    </section>
  );
}
