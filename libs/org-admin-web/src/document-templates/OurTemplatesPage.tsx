import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { safeErrorMessage, type Session } from '@aramo/fe-foundation';
import {
  canApproveTemplates,
  fetchTemplateLibrary,
  fmtDate,
  listTemplateSelections,
  listTemplateVersions,
  resolveUserNames,
  useDocTemplateRoutes,
  type TemplateStatus,
  type TemplateVersionView,
} from '@aramo/document-templates-web';

import { OrgPageHeader } from '../ui/OrgPage';

import { fetchTemplateNotices, noticeMessage, type TemplateWithdrawalNotice } from './notices-api';
import { buildOurTemplateRows, hasLegacySelection, type OurTemplateRow } from './templates-view';
import './templates.css';

// ORG-UX-1 — Our templates (Directive v1.0 LOCKED §3, §5, §8.8; handoff rev. Oct 21 §6.8).
// The organization's own templates (adopted from the gallery or created), one row each:
// Template · Used in · Version · Status · Last approved · Manage (→ the existing editor).
// A grandfathered tenant-wide selection of an Aramo default (legacy_platform, §5.3 T-A)
// shows the "Aramo starting point" banner; Aramo withdrawal notices (T-6) stay as banners.
// No selection control: approving a draft makes it the template in use (§5.2), and a
// selection can no longer point at an Aramo default.

export const OUR_TEMPLATES_COLUMNS = 'minmax(240px,1.8fr) minmax(140px,1fr) 70px 96px minmax(170px,1fr) 90px';
export const LEGACY_BANNER_TEXT = 'You’re using an Aramo starting point. Adopt and approve your own version.';

const GALLERY_PATH = '/org/document-templates/gallery';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: readonly OurTemplateRow[]; legacy: boolean; names: Readonly<Record<string, string>> };

interface Props {
  readonly session: Session;
  readonly libraryFn?: typeof fetchTemplateLibrary;
  readonly selectionsFn?: typeof listTemplateSelections;
  readonly versionsFn?: typeof listTemplateVersions;
  readonly namesFn?: typeof resolveUserNames;
  readonly noticesFn?: typeof fetchTemplateNotices;
}

const PILL: Readonly<Record<TemplateStatus, { label: string; cls: string }>> = {
  DRAFT: { label: 'Draft', cls: 'ox-pill--warn' },
  ACTIVE: { label: 'Active', cls: 'ox-pill--active' },
  RETIRED: { label: 'Retired', cls: 'ox-pill--disabled' },
};

export function OurTemplatesPage({
  session,
  libraryFn = fetchTemplateLibrary,
  selectionsFn = listTemplateSelections,
  versionsFn = listTemplateVersions,
  namesFn = resolveUserNames,
  noticesFn = fetchTemplateNotices,
}: Props) {
  const routes = useDocTemplateRoutes();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [notices, setNotices] = useState<readonly TemplateWithdrawalNotice[]>([]);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      // Selections only feed the banner: a failed read means no banner, never a broken page.
      const [library, selections] = await Promise.all([libraryFn(), selectionsFn().catch(() => [])]);
      const own = library.items.filter((i) => i.owner_scope === 'TENANT');
      const versionLists = await Promise.all(own.map((t) => versionsFn(t.id).catch((): readonly TemplateVersionView[] => [])));
      const versionsById = new Map(own.map((t, i) => [t.id, versionLists[i] ?? []]));
      const rows = buildOurTemplateRows(library, versionsById);
      const approverIds = rows.map((r) => r.lastApproved?.by).filter((x): x is string => x != null);
      let names: Record<string, string> = {};
      if (approverIds.length > 0) {
        try {
          names = await namesFn(approverIds);
        } catch {
          names = {};
        }
      }
      setLoad({ status: 'ready', rows, legacy: hasLegacySelection(selections), names });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Could not load your templates.') });
    }
  }, [libraryFn, selectionsFn, versionsFn, namesFn]);

  useEffect(() => {
    void refetch();
    void noticesFn().then(setNotices, () => setNotices([]));
  }, [refetch, noticesFn]);

  const canApprove = canApproveTemplates(session);

  return (
    <div className="ox-tpl" data-testid="our-templates">
      <OrgPageHeader section="templates" />

      {load.status === 'ready' && load.legacy ? (
        <div className="ox-alert ox-alert--info ox-tpl__banner" role="status" data-testid="our-templates-legacy">
          {LEGACY_BANNER_TEXT}{' '}
          <Link className="ox-link" to={GALLERY_PATH}>
            Open the Template gallery
          </Link>
        </div>
      ) : null}
      {notices.map((n) => (
        <div className="ox-alert ox-alert--warn ox-tpl__banner" role="status" key={n.template_id} data-testid={`dt-notice-${n.template_id}`}>
          {noticeMessage(n, fmtDate, canApprove)}
        </div>
      ))}

      <section className="ox-card ox-table-wrap" aria-label="Our templates" aria-busy={load.status === 'loading'}>
        <div className="ox-table" role="table" style={{ minWidth: 900 }}>
          <div className="ox-tr ox-tr--head ox-tpl__tr" role="row" style={{ gridTemplateColumns: OUR_TEMPLATES_COLUMNS }}>
            <span role="columnheader">Template</span>
            <span role="columnheader">Used in</span>
            <span role="columnheader">Version</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Last approved</span>
            <span role="columnheader">
              <span className="ox-sr-only">Actions</span>
            </span>
          </div>
          {load.status === 'loading' ? (
            <div className="ox-empty" role="row">
              <span role="cell">Loading…</span>
            </div>
          ) : null}
          {load.status === 'error' ? (
            <div className="ox-empty" role="row">
              <span role="cell">
                <span role="alert">{load.message}</span>{' '}
                <button type="button" className="ox-link" onClick={() => void refetch()}>
                  Try again
                </button>
              </span>
            </div>
          ) : null}
          {load.status === 'ready' && load.rows.length === 0 ? (
            <div className="ox-empty" role="row" data-testid="our-templates-empty">
              <span role="cell">
                Your organization has no templates yet. Start from the{' '}
                <Link className="ox-link" to={GALLERY_PATH}>
                  Template gallery
                </Link>
                : adopt a ready-made starting point, then approve it.
              </span>
            </div>
          ) : null}
          {load.status === 'ready'
            ? load.rows.map((r) => {
                const pill = PILL[r.status];
                const by = r.lastApproved?.by != null ? load.names[r.lastApproved.by] : undefined;
                return (
                  <div className="ox-tr ox-tpl__tr" role="row" key={r.id} style={{ gridTemplateColumns: OUR_TEMPLATES_COLUMNS }} data-testid={`our-template-${r.id}`}>
                    <span role="cell" className="ox-tpl__name">
                      <span className="ox-tpl__thumb" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="ox-tpl__nametext">
                        <span className="ox-tpl__title">{r.name}</span>
                        <span className="ox-tpl__type">{r.typeName}</span>
                      </span>
                    </span>
                    <span role="cell">{r.usedIn}</span>
                    <span role="cell" className="ox-mono ox-tpl__ver">
                      {r.version}
                    </span>
                    <span role="cell">
                      <span className={`ox-pill ${pill.cls}`}>{pill.label}</span>
                    </span>
                    <span role="cell" className="ox-tpl__when">
                      {r.lastApproved === null ? '—' : `${fmtDate(r.lastApproved.at)}${by !== undefined && by !== '' ? ` · ${by}` : ''}`}
                    </span>
                    <span role="cell" className="ox-tpl__act">
                      <Link className="ox-btn ox-btn--secondary ox-tpl__manage" to={routes.detail(r.id)} aria-label={`Manage ${r.name}`}>
                        Manage
                      </Link>
                    </span>
                  </div>
                );
              })
            : null}
        </div>
      </section>

      <p className="ox-tpl__foot">
        Need a new document type? Start from the{' '}
        <Link className="ox-link" to={GALLERY_PATH}>
          Template gallery
        </Link>
        .
      </p>
    </div>
  );
}
