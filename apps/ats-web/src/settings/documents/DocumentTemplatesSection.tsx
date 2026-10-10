import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, hasScope, useSession, type Session } from '@aramo/fe-foundation';

import {
  listDocumentTemplates,
  listTemplateVersions,
  DOC_TEMPLATE_READ_SCOPE,
  RIGHT_TO_REPRESENT_TYPE_ID,
  type TemplateVersionView,
} from './document-templates-api';
import { DocIcon, fmtDate } from './dt-ui';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§6) — Settings → Documents → Document templates CATALOG,
// styled to the approved prototype: a single compact table card (not a card stack).
// Exactly one document type is tenant-configurable this increment — Right to Represent
// (outline Manage). Every other governed type is listed honestly as "Not configurable
// yet" (muted row, no action) — no dead knobs. The backend is the boundary.

const READ_SCOPE = DOC_TEMPLATE_READ_SCOPE;
const DETAIL_ROUTE = '/admin/settings/document-templates/rtr';

interface Row {
  readonly key: string;
  readonly name: string;
  readonly sub: string;
  readonly configurable: boolean;
}

const ROWS: readonly Row[] = [
  { key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', sub: 'Sent from Requisition → Talent before client submittal', configurable: true },
  { key: 'OFFER_LETTER', name: 'Offer Letter', sub: 'E-sign flow exists · not yet driven by tenant templates', configurable: false },
  { key: 'CLIENT_NDA', name: 'Client NDA', sub: 'Pre-start requirement exists · template signing not built yet', configurable: false },
  { key: 'BACKGROUND_AUTHORIZATION', name: 'Background Authorization', sub: 'Pre-start requirement exists · template signing not built yet', configurable: false },
  { key: 'I9', name: 'I-9', sub: 'Pre-start requirement exists · template signing not built yet', configurable: false },
];

interface RtrFacts {
  readonly version: number | null;
  readonly approved: string;
}

export function DocumentTemplatesSection({ sessionOverride }: { readonly sessionOverride?: Session } = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, READ_SCOPE);
  const navigate = useNavigate();
  const [rtr, setRtr] = useState<RtrFacts>({ version: null, approved: '—' });

  const load = useCallback(async () => {
    try {
      const templates = await listDocumentTemplates();
      const t = templates.find((x) => x.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID) ?? null;
      if (t == null) return;
      const versions = await listTemplateVersions(t.id);
      const active = versions.find((v: TemplateVersionView) => v.id === t.current_version_id) ?? null;
      if (active != null) setRtr({ version: active.version_number, approved: fmtDate(active.activated_at) });
    } catch {
      /* the catalog still renders; the RTR facts are best-effort decoration */
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [canRead, load]);

  if (!canRead) {
    return (
      <div className="dt-root">
        <div className="dt-noaccess">
          <div className="dt-noaccess__t">Document templates are managed by your Tenant Admins</div>
          <div className="dt-noaccess__b">
            When you send a Right to Represent, Aramo uses the version your organization approved. You
            don’t need to pick or edit a template.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dt-root">
      <div className="dt-wrap">
        <h1 className="dt-h1">Document templates</h1>
        <p className="dt-lede">
          Manage the approved document templates your recruiting and onboarding workflows use.
          Recruiters never choose a template; workflows always use the active approved version.
        </p>
        <div className="dt-tablecard">
          <div className="dt-table">
            <div className="dt-grid dt-thead">
              <span>DOCUMENT</span>
              <span>STATUS</span>
              <span>APPROVED</span>
              <span>SCOPE</span>
              <span>LAST APPROVED</span>
              <span className="dt-th-action">ACTION</span>
            </div>
            {ROWS.map((r) => (
              <div
                key={r.key}
                className={`dt-grid dt-row${r.configurable ? '' : ' dt-row--muted'}`}
                data-testid={`doc-template-row-${r.key}`}
              >
                <span className="dt-doc">
                  <span className={`dt-ic ${r.configurable ? 'dt-ic--rtr' : 'dt-ic--muted'}`}>
                    <DocIcon />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className={`dt-name${r.configurable ? '' : ' dt-name--muted'}`}>{r.name}</span>
                    <span className="dt-sub">{r.sub}</span>
                  </span>
                </span>
                <span>
                  {r.configurable ? (
                    <span className="dt-pill dt-pill--active"><span className="dt-pill__dot" />Active</span>
                  ) : (
                    <span className="dt-pill dt-pill--muted"><span className="dt-pill__dot" />Not configurable yet</span>
                  )}
                </span>
                <span className={`dt-cell dt-cell--v ${r.configurable ? 'dt-cell--on' : 'dt-cell--muted'}`}>
                  {r.configurable ? (rtr.version != null ? `v${rtr.version}` : '—') : '—'}
                </span>
                <span className={`dt-cell ${r.configurable ? 'dt-cell--on' : 'dt-cell--muted'}`}>
                  {r.configurable ? 'Tenant default' : '—'}
                </span>
                <span className={`dt-cell ${r.configurable ? 'dt-cell--on' : 'dt-cell--muted'}`}>
                  {r.configurable ? rtr.approved : '—'}
                </span>
                <span className="dt-action">
                  {r.configurable ? (
                    <Button
                      unstyled
                      className="dt-btn dt-btn--outline"
                      onClick={() => navigate(DETAIL_ROUTE)}
                      data-testid={`doc-template-manage-${r.key}`}
                    >
                      Manage
                    </Button>
                  ) : (
                    <span className="dt-dash">—</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="dt-foot">
          Documents marked “Not configurable yet” can't be edited here until their signing flow uses
          tenant templates.
        </div>
      </div>
    </div>
  );
}
