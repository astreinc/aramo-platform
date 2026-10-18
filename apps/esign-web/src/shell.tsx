import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Input, logout } from '@aramo/fe-foundation';

import { senderApi, type LedgerEvent } from './api';
import { Avatar, Bare, Btn, Icon, eventDot, eventLabel, rel } from './ui';
import { useWorkspace } from './workspace';

// The Sign console shell (prototype: white sidebar + top bar). Sidebar groups:
// WORKSPACE · INSIGHTS · ADMINISTRATION. ≥900px the menu button collapses the
// sidebar; <900px the sidebar is a drawer with a scrim that closes on navigate.
// Top bar: search, app switcher (change log B1), notifications, help,
// organization name, account menu. No signer-app link and no ATS chrome.

interface NavItem {
  to: string;
  label: string;
  icon: string;
  count?: number;
  end?: boolean;
}

function useNarrow(): boolean {
  const q = '(max-width: 899px)';
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function ConsoleShell({ children, scopes }: { children: ReactNode; scopes: readonly string[] }) {
  const { ctx, base, awaiting } = useWorkspace();
  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);

  const personal = ctx.workspace === 'personal';
  const groups: { label: string; items: NavItem[] }[] = personal
    ? [
        {
          label: 'My workspace',
          items: [
            { to: base, label: 'Home', icon: 'home', end: true },
            { to: `${base}/envelopes`, label: 'Envelopes', icon: 'mail', count: awaiting },
            { to: `${base}/documents`, label: 'Documents', icon: 'doc' },
          ],
        },
        { label: 'Insights', items: [{ to: `${base}/activity`, label: 'Activity', icon: 'activity' }] },
        { label: 'Account', items: [{ to: `${base}/settings`, label: 'Settings', icon: 'settings' }] },
      ]
    : [
        {
          label: 'Workspace',
          items: [
            { to: base, label: 'Dashboard', icon: 'home', end: true },
            { to: `${base}/envelopes`, label: 'Envelopes', icon: 'mail', count: awaiting },
            { to: `${base}/templates`, label: 'Templates', icon: 'tpl' },
            { to: `${base}/documents`, label: 'Documents', icon: 'doc' },
            { to: `${base}/contacts`, label: 'Contacts', icon: 'contacts' },
          ],
        },
        {
          label: 'Insights',
          items: [
            { to: `${base}/reports`, label: 'Reports', icon: 'reports' },
            { to: `${base}/activity`, label: 'Activity', icon: 'activity' },
          ],
        },
        { label: 'Administration', items: [{ to: `${base}/settings`, label: 'Settings', icon: 'settings' }] },
      ];

  const sidebar = (
    <aside className="sg-side" aria-label="Aramo Sign navigation">
      <div className="sg-brand">
        <span className="sg-brand__mark">S</span>
        <div>
          <div className="sg-brand__name">Aramo Sign</div>
          <div className="sg-brand__host">esign.aramo.ai · {personal ? 'personal' : 'console'}</div>
        </div>
      </div>
      <div className="sg-side__new">
        {ctx.can_send ? (
          <Link to={`${base}/envelopes/new`} className="sg-btn sg-btn--primary sg-btn--block" data-testid="new-envelope">
            <Icon name="plus" /> New envelope
          </Link>
        ) : (
          <Btn variant="primary" block disabled title={personal ? 'Sending from a personal account isn’t enabled yet' : 'You don’t have permission to send envelopes'} data-testid="new-envelope-disabled">
            <Icon name="plus" /> New envelope
          </Btn>
        )}
      </div>
      <nav className="sg-side__scroll">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sg-side__group">{g.label}</div>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end === true} className={({ isActive }) => (isActive ? 'sg-nav sg-nav--on' : 'sg-nav')}>
                <span className="sg-nav__icon">
                  <Icon name={it.icon} />
                </span>
                {it.label}
                {it.count !== undefined && it.count > 0 ? <span className="sg-nav__count">{it.count}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sg-side__foot">
        <div className="sg-products" title={ctx.tenant.name}>
          <span className="sg-products__mark">A</span>
          <span>
            <div className="sg-products__t">Aramo products</div>
            <div className="sg-products__s">{ctx.tenant.name}</div>
          </span>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="sg sg-layout">
      {narrow ? (
        drawer ? (
          <>
            <div className="sg-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
            <div className="sg-drawer">{sidebar}</div>
          </>
        ) : null
      ) : collapsed ? null : (
        sidebar
      )}
      <div className="sg-main">
        <TopBar onMenu={() => (narrow ? setDrawer((d) => !d) : setCollapsed((c) => !c))} scopes={scopes} />
        <main>{children}</main>
      </div>
    </div>
  );
}

function usePopover(): [boolean, (v?: boolean) => void, React.RefObject<HTMLDivElement>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return [open, (v?: boolean) => setOpen((o) => (v === undefined ? !o : v)), ref];
}

function TopBar({ onMenu, scopes }: { onMenu: () => void; scopes: readonly string[] }) {
  const { ctx, base } = useWorkspace();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sw, toggleSw, swRef] = usePopover();
  const [nt, toggleNt, ntRef] = usePopover();
  const [hp, toggleHp, hpRef] = usePopover();
  const [me, toggleMe, meRef] = usePopover();
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  useEffect(() => {
    if (!nt || events !== null) return;
    senderApi
      .activity(6)
      .then((r) => setEvents(r.items))
      .catch(() => setEvents([]));
  }, [nt, events]);
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    nav(`${base}/envelopes${q.trim() === '' ? '' : `?q=${encodeURIComponent(q.trim())}`}`);
  };
  const isOrgAdmin = scopes.includes('tenant:admin:profile') || scopes.includes('tenant:admin:user-manage');
  const name = ctx.user.display_name ?? ctx.user.email ?? 'You';

  return (
    <header className="sg-top">
      <Bare className="sg-iconbtn" aria-label="Toggle navigation" onClick={onMenu}>
        <Icon name="menu" />
      </Bare>
      <form className="sg-search" role="search" onSubmit={onSearch}>
        <Icon name="search" size={14} />
        <Input unstyled aria-label="Search envelopes" placeholder="Search envelopes, recipients…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <div className="sg-top__right">
        <div className="sg-anchor" ref={swRef}>
          <Bare className="sg-iconbtn" aria-label="Aramo apps" aria-expanded={sw} onClick={() => toggleSw()} data-testid="app-switcher">
            <Icon name="grid" />
          </Bare>
          {sw ? (
            <div className="sg-pop" role="menu" aria-label="Aramo apps">
              <div className="sg-pop__head">Aramo apps</div>
              {ctx.app_home_url !== null ? (
                <a className="sg-pop__row" role="menuitem" href={ctx.app_home_url}>
                  <span>
                    <strong>App Home</strong>
                    <div className="sg-muted">Your apps and organization</div>
                  </span>
                </a>
              ) : null}
              {ctx.app_home_url !== null && ctx.workspace === 'sign' ? (
                <a className="sg-pop__row" role="menuitem" href={`${ctx.app_home_url}ats/`}>
                  <span>
                    <strong>Aramo ATS</strong>
                    <div className="sg-muted">Opens after the access check</div>
                  </span>
                </a>
              ) : null}
              <div className="sg-pop__row sg-pop__row--off" aria-current="true">
                <span>
                  <strong>Aramo Sign</strong>
                  <div className="sg-muted">You are here</div>
                </span>
              </div>
              {isOrgAdmin && ctx.organization_url !== null ? (
                <a className="sg-pop__row" role="menuitem" href={ctx.organization_url.replace(/\/profile$/, '/users')}>
                  <span>
                    <strong>Organization</strong>
                    <div className="sg-muted">Users, access and organization settings</div>
                  </span>
                </a>
              ) : null}
              <div className="sg-pop__foot">Each app checks your access again when it opens.</div>
            </div>
          ) : null}
        </div>
        <div className="sg-anchor" ref={ntRef}>
          <Bare className="sg-iconbtn" aria-label="Notifications" aria-expanded={nt} onClick={() => toggleNt()}>
            <Icon name="bell" />
          </Bare>
          {nt ? (
            <div className="sg-pop" role="dialog" aria-label="Recent activity">
              <div className="sg-pop__head">Recent activity</div>
              {events === null ? <div className="sg-pop__foot">Loading…</div> : null}
              {events !== null && events.length === 0 ? <div className="sg-pop__foot">Nothing yet.</div> : null}
              {(events ?? []).map((e) => (
                <Link key={e.id} className="sg-pop__row" to={`${base}/envelopes/${e.envelope_id ?? ''}`} onClick={() => toggleNt(false)}>
                  <span className="sg-swatch" style={{ background: eventDot(e.event_type), marginTop: 6 }} />
                  <span className="sg-row__main">
                    <div className="sg-ellipsis">{eventLabel(e.event_type, e.detail)}</div>
                    <div className="sg-muted sg-ellipsis" style={{ fontSize: 12 }}>
                      {e.envelope_subject} · {rel(e.occurred_at)}
                    </div>
                  </span>
                </Link>
              ))}
              <Link className="sg-pop__foot" style={{ display: 'block' }} to={`${base}/activity`} onClick={() => toggleNt(false)}>
                View all activity
              </Link>
            </div>
          ) : null}
        </div>
        <div className="sg-anchor" ref={hpRef}>
          <Bare className="sg-iconbtn" aria-label="Help" aria-expanded={hp} onClick={() => toggleHp()}>
            <Icon name="help" />
          </Bare>
          {hp ? (
            <div className="sg-pop" role="dialog" aria-label="Help">
              <div className="sg-pop__head">Help</div>
              <div className="sg-pop__foot" style={{ background: 'transparent' }}>
                Create an envelope, add PDFs and recipients, place each signer’s fields, then send. Recipients sign at sign.aramo.ai through a secure
                link sent by email; they don’t need an Aramo account. Each signing link is valid for 7 days.
              </div>
            </div>
          ) : null}
        </div>
        <span className="sg-top__org" style={{ fontWeight: 600 }}>
          {ctx.tenant.name}
        </span>
        <div className="sg-anchor" ref={meRef}>
          <Bare className="sg-avatarbtn" aria-label={`Account: ${name}`} aria-expanded={me} onClick={() => toggleMe()}>
            <Avatar name={name} />
          </Bare>
          {me ? (
            <div className="sg-pop" role="menu" aria-label="Account">
              <div className="sg-pop__head">
                {name}
                <div className="sg-muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
                  {ctx.user.email}
                </div>
              </div>
              <Link className="sg-pop__row" role="menuitem" to={`${base}/settings/personal`} onClick={() => toggleMe(false)}>
                Sign settings
              </Link>
              {ctx.app_home_url !== null ? (
                <a className="sg-pop__row" role="menuitem" href={`${ctx.app_home_url}preferences`}>
                  My Aramo account
                </a>
              ) : null}
              <Bare className="sg-pop__row" role="menuitem" style={{ color: 'var(--bad)' }} onClick={() => void logout()} data-testid="sign-out">
                Sign out
              </Bare>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
