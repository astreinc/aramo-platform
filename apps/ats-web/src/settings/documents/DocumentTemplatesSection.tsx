import { useNavigate } from 'react-router-dom';
import { hasScope, IconFile, useSession, type Session } from '@aramo/fe-foundation';

import { Button, Card } from '../../ui';
import { SettingsSection, SettingCardHead, StatChip, SettingHint } from '../components';

import { DOC_TEMPLATE_READ_SCOPE } from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§6) — Settings → Documents → Document templates CATALOG.
// A tenant admin governs the content of the documents the workspace sends. In this
// increment exactly ONE document type is tenant-configurable: Right to Represent.
// Every other governed type is listed HONESTLY as "Not configurable yet" — a real
// product surface, never a dead knob and never a fake control (the no-dead-knobs
// invariant). The backend is the boundary: RBAC and the lifecycle are server-owned;
// this page only hides what the viewer cannot do.

const READ_SCOPE = DOC_TEMPLATE_READ_SCOPE;

interface CatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly summary: string;
  readonly configurable: boolean;
  /** Detail route (under /admin) for a configurable type. */
  readonly to?: string;
}

// The governed document types known to the product (seeded DocumentTypes). Only RTR
// is tenant-template configurable this increment; the rest are honest placeholders.
const CATALOG: readonly CatalogEntry[] = [
  {
    key: 'RIGHT_TO_REPRESENT',
    label: 'Right to Represent',
    summary:
      'The representation agreement a recruiter sends to talent before submitting them to a client. Tenant-governed content with a safe field catalog.',
    configurable: true,
    to: '/admin/settings/document-templates/rtr',
  },
  {
    key: 'OFFER_LETTER',
    label: 'Offer Letter',
    summary: 'The offer document issued to talent. Configuration arrives in a later release.',
    configurable: false,
  },
  {
    key: 'CLIENT_NDA',
    label: 'Client NDA',
    summary: 'A non-disclosure agreement bound to a client engagement.',
    configurable: false,
  },
  {
    key: 'BACKGROUND_AUTHORIZATION',
    label: 'Background Authorization',
    summary: 'Talent authorization to run a background check.',
    configurable: false,
  },
  {
    key: 'I9',
    label: 'I-9 (Employment Eligibility Verification)',
    summary: 'Employment eligibility verification paperwork.',
    configurable: false,
  },
];

export function DocumentTemplatesSection({ sessionOverride }: { readonly sessionOverride?: Session } = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, READ_SCOPE);
  const navigate = useNavigate();

  const description = (
    <>
      Govern the content of the documents your workspace sends. Recruiters never choose a template —
      they send the current approved version; you decide what that version says here.
    </>
  );

  if (!canRead) {
    return (
      <SettingsSection title="Document templates" description={description}>
        <Card>
          <SettingHint>
            You don’t have permission to manage document templates. Ask a workspace admin for the
            document-template permission.
          </SettingHint>
        </Card>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Document templates" description={description}>
      {CATALOG.map((entry) => (
        <Card key={entry.key}>
          <SettingCardHead icon={<IconFile />} title={entry.label} sub={entry.summary} />
          <div className="set-row">
            <div className="set-row__l">
              {entry.configurable ? (
                <StatChip tone="brand" dot>
                  Configurable
                </StatChip>
              ) : (
                <StatChip tone="muted" dot>
                  Not configurable yet
                </StatChip>
              )}
            </div>
            <div className="set-row__r">
              {entry.configurable && entry.to != null ? (
                <Button
                  onClick={() => navigate(entry.to as string)}
                  data-testid={`doc-template-manage-${entry.key}`}
                >
                  Manage
                </Button>
              ) : (
                <Button variant="ghost" disabled>
                  Not configurable yet
                </Button>
              )}
            </div>
          </div>
        </Card>
      ))}
    </SettingsSection>
  );
}
