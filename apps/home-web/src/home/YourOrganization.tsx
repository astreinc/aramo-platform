import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, initialsOf } from '@aramo/fe-foundation';
import { InviteUserModal, orgSectionByKey, useSetupChecklist } from '@aramo/org-admin-web';

import { useOrgShortcutCounts } from './org-counts';

// ORG-UX-1 (handoff §5 "Your organization"; directive §8.1) — App Home's organization
// area, shown to organization admins (server org_access "admin") ONLY. It replaces the
// 8 link tiles: a Setup card (progress + the first 2 unfinished checklist items) and a
// Shortcuts card (Invite user in place, Users & invitations, Roles & access, Our
// templates). Values per the prototype (platform/Aramo App Home.dc.html).

const ICON_MAIL = 'M3 6h18v12H3zM3 7l9 6 9-6';
const CHEVRON = 'm9 6 6 6-6 6';

function Glyph({ d, size = 16 }: { readonly d: string; readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function SetupCard({ org }: { readonly org: string }) {
  const checklist = useSetupChecklist();
  const ready = checklist.status === 'ready' ? checklist : null;
  const pending = ready === null ? [] : ready.items.filter((i) => !i.done).slice(0, 2);
  const pct = ready === null || ready.total === 0 ? 0 : Math.round((ready.done / ready.total) * 100);
  return (
    <div className="home-orgcard home-setup" data-testid="home-org-setup">
      <div className="home-setup__head">
        <span className="home-setup__tile" aria-hidden="true">
          {initialsOf(org)}
        </span>
        <span className="home-setup__who">
          <span className="home-setup__name">{org}</span>
          {ready !== null ? (
            <span className="home-setup__sub" data-testid="home-org-setup-progress">
              Setup · {ready.done} of {ready.total} done
            </span>
          ) : checklist.status === 'loading' ? (
            <span className="home-skeleton home-skeleton--line" aria-hidden="true" />
          ) : null}
        </span>
      </div>
      {ready !== null ? (
        <div className="home-setup__bar" aria-hidden="true">
          <div className="home-setup__fill" style={{ width: `${pct}%` }} />
        </div>
      ) : checklist.status === 'loading' ? (
        <div className="home-setup__bar home-skeleton" aria-hidden="true" data-testid="home-org-setup-loading" />
      ) : null}
      {pending.length > 0 ? (
        <div className="home-setup__items">
          {pending.map((it) => (
            <Link key={it.key} to={it.path} className="home-setup__item" data-testid={`home-setup-${it.key}`}>
              <span className="home-setup__circle" aria-hidden="true" />
              <span className="home-setup__text">
                <span className="home-setup__label">{it.label}</span>
                <span className="home-setup__hint">{it.hint}</span>
              </span>
              <span className="home-chev">
                <Glyph d={CHEVRON} size={14} />
              </span>
            </Link>
          ))}
        </div>
      ) : null}
      <Link to="/org/overview" className="home-secondary" data-testid="home-open-org">
        Open organization
      </Link>
    </div>
  );
}

function ShortcutRow({ icon, label, sub, testId }: { readonly icon: string; readonly label: string; readonly sub: string | null; readonly testId: string }) {
  return (
    <>
      <span className="home-shortcut__icon">
        <Glyph d={icon} />
      </span>
      <span className="home-shortcut__text">
        <span className="home-shortcut__label">{label}</span>
        {sub !== null ? (
          <span className="home-shortcut__sub" data-testid={`${testId}-sub`}>
            {sub}
          </span>
        ) : null}
      </span>
      <span className="home-chev">
        <Glyph d={CHEVRON} size={14} />
      </span>
    </>
  );
}

function ShortcutsCard() {
  const [inviting, setInviting] = useState(false);
  const counts = useOrgShortcutCounts(true);
  const users = orgSectionByKey('users');
  const roles = orgSectionByKey('roles');
  const templates = orgSectionByKey('templates');
  return (
    <div className="home-orgcard home-shortcuts" data-testid="home-org-shortcuts">
      <div className="home-shortcuts__title">Shortcuts</div>
      <Button unstyled type="button" className="home-shortcut" onClick={() => setInviting(true)} data-testid="home-shortcut-invite">
        <ShortcutRow icon={ICON_MAIL} label="Invite user" sub="Send an invitation" testId="home-shortcut-invite" />
      </Button>
      <Link to={users.path} className="home-shortcut" data-testid="home-shortcut-users">
        <ShortcutRow
          icon={users.iconPath}
          label={users.label}
          sub={counts.users === null ? null : `${counts.users.active} active · ${counts.users.invited} invited`}
          testId="home-shortcut-users"
        />
      </Link>
      <Link to={roles.path} className="home-shortcut" data-testid="home-shortcut-roles">
        <ShortcutRow icon={roles.iconPath} label={roles.label} sub="Who holds each role" testId="home-shortcut-roles" />
      </Link>
      <Link to={templates.path} className="home-shortcut" data-testid="home-shortcut-templates">
        <ShortcutRow
          icon={templates.iconPath}
          label={templates.label}
          sub={counts.activeTemplates === null ? null : `${counts.activeTemplates} active`}
          testId="home-shortcut-templates"
        />
      </Link>
      <InviteUserModal open={inviting} onOpenChange={setInviting} onInvited={counts.reloadUsers} />
    </div>
  );
}

export function YourOrganization({ org }: { readonly org: string }) {
  return (
    <section className="home-yourorg" aria-labelledby="home-yourorg-label" data-testid="home-your-org">
      <div className="home-label home-label--admin">
        <span id="home-yourorg-label">Your organization</span> <span className="home-admin">ADMIN</span>
        <span className="home-label__cap">Shared by every Aramo app · not a subscription</span>
      </div>
      <div className="home-orggrid">
        <SetupCard org={org} />
        <ShortcutsCard />
      </div>
    </section>
  );
}
