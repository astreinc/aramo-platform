import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, Button, Icons, StatusPill, Tag } from '../../ui';
import { listContactsForCompany } from '../companies-api';
import type { CompanyView, ContactView } from '../types';
import {
  RELATIONSHIP_TONES,
  lastContactLabel,
  locationOf,
  relationshipLabel,
  tierLabel,
} from '../company-workspace';

// CompanyDrawer — right slide-in account preview (mirrors TalentTriageDrawer).
// NON-MODAL (the list stays visible to page prev/next). Identity + at-a-glance
// come from the already-loaded row (no refetch); the primary contact is one
// live read (graceful on 403/404). "Open account" → the account hub. Every
// value is a real CompanyView field — no fabricated metrics.

interface CompanyDrawerProps {
  readonly company: CompanyView | null;
  readonly index: number;
  readonly total: number;
  readonly ownerNames: Record<string, string>;
  readonly onClose: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
}

function primaryContactName(c: ContactView): string {
  const name = `${c.first_name} ${c.last_name}`.trim();
  return name === '' ? 'Contact' : name;
}

export function CompanyDrawer({
  company,
  index,
  total,
  ownerNames,
  onClose,
  onPrev,
  onNext,
}: CompanyDrawerProps) {
  const [contact, setContact] = useState<ContactView | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const [contactError, setContactError] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const companyId = company?.id ?? null;

  useEffect(() => {
    if (companyId === null) return;
    let cancelled = false;
    setContact(null);
    setContactError(false);
    setContactLoading(true);
    void listContactsForCompany(companyId)
      .then((res) => {
        if (cancelled) return;
        setContact(res.items[0] ?? null);
        setContactLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setContactError(true);
        setContactLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // a11y: capture trigger, move focus into the drawer on open, restore on close.
  useEffect(() => {
    if (companyId === null) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    headingRef.current?.focus();
    const toRestore = restoreRef.current;
    return () => toRestore?.focus();
  }, [companyId]);

  // Esc closes; Tab is trapped within the drawer (dialog semantics).
  useEffect(() => {
    if (companyId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = asideRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [companyId, onClose]);

  if (company === null) return null;
  const owner = company.owner_id ? (ownerNames[company.owner_id] ?? null) : null;
  const tier = tierLabel(company.client_tier);
  const tags = company.tags ?? [];

  return (
    <aside
      ref={asideRef}
      className="rc-drawer rc-drawer--open"
      role="dialog"
      aria-modal="false"
      aria-label={`${company.name} — preview`}
    >
      <div className="rc-drawer__hd">
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Previous company"
          onClick={onPrev}
          disabled={index <= 0}
        >
          <Icons.IconChevronLeft />
        </button>
        <button
          type="button"
          className="rc-drawer__nav"
          aria-label="Next company"
          onClick={onNext}
          disabled={index >= total - 1}
        >
          <Icons.IconChevronRight />
        </button>
        <span className="rc-drawer__pos num">
          {index + 1} of {total}
        </span>
        <button
          type="button"
          className="rc-drawer__x"
          aria-label="Close"
          onClick={onClose}
        >
          <Icons.IconX />
        </button>
      </div>

      <div className="rc-drawer__body">
        <div className="rc-drawer__id">
          <Avatar name={company.name} size="lg" />
          <div>
            <h3 ref={headingRef} tabIndex={-1}>
              {company.name}
              {company.is_hot ? (
                <Icons.IconFlame className="rc-drawer__flame" />
              ) : null}
            </h3>
            <div className="rc-drawer__rl">
              {[company.industry, locationOf(company)]
                .filter((s) => s && s !== '—')
                .join(' · ') || 'Company'}
            </div>
            <div className="rc-drawer__pills">
              <StatusPill tone={RELATIONSHIP_TONES[company.status] ?? 'neutral'} dot>
                {relationshipLabel(company.status)}
              </StatusPill>
              {tier !== null ? <StatusPill tone="brand">{tier}</StatusPill> : null}
            </div>
          </div>
        </div>

        <div className="rc-drawer__act">
          <Link to={`/companies/${company.id}`} className="rc-drawer__act-full">
            <Button variant="primary">
              <Icons.IconOpen /> Open account
            </Button>
          </Link>
        </div>

        <section className="rc-drawer__sec">
          <h4>At a glance</h4>
          <div className="rc-kv">
            <span className="rc-kv__k">Relationship</span>
            <span className="rc-kv__v">{relationshipLabel(company.status)}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Tier</span>
            <span className="rc-kv__v">{tier ?? '—'}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Industry</span>
            <span className="rc-kv__v">{company.industry ?? '—'}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Location</span>
            <span className="rc-kv__v">{locationOf(company)}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Owner</span>
            <span className="rc-kv__v">{owner ?? '—'}</span>
          </div>
          <div className="rc-kv">
            <span className="rc-kv__k">Last contact</span>
            <span className="rc-kv__v">{lastContactLabel(company)}</span>
          </div>
        </section>

        {tags.length > 0 ? (
          <section className="rc-drawer__sec">
            <h4>Tags</h4>
            <div className="rc-drawer__skills">
              {tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rc-drawer__sec">
          <h4>Primary contact</h4>
          {contactLoading ? (
            <p className="rc-drawer__empty">Loading…</p>
          ) : contactError ? (
            <p className="rc-drawer__empty">Couldn’t load contacts.</p>
          ) : contact === null ? (
            <p className="rc-drawer__empty">No contacts on this account yet.</p>
          ) : (
            <div className="rc-drawer__pipe">
              <Avatar name={primaryContactName(contact)} size="sm" />
              <span>
                <span className="rc-drawer__feed-t">
                  {primaryContactName(contact)}
                </span>
                {contact.title !== null && contact.title !== '' ? (
                  <span className="rc-drawer__feed-w">{contact.title}</span>
                ) : null}
              </span>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
