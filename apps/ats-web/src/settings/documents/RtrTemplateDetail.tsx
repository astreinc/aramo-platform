import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasScope, IconFile, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, EmptyState, ErrorState, LoadingState, safeErrorMessage } from '../../ui';
import { SettingsSection, SettingCardHead, StatChip, SettingHint } from '../components';

import {
  createDraftFromActive,
  listDocumentTemplates,
  listTemplateVersions,
  DOC_TEMPLATE_MANAGE_SCOPE,
  DOC_TEMPLATE_READ_SCOPE,
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateStatus,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§7) — the Right-to-Represent template detail. Shows the
// template header + lifecycle status, the current approved (ACTIVE) version, the full
// version history (DRAFT/ACTIVE/RETIRED — historical versions are pinned forever, §34),
// and the admin actions. One DRAFT at a time (§41): the action is either "Edit draft"
// (an open DRAFT exists) or "Create new draft" (copies the current ACTIVE content). The
// draft editor (name/title/blocks + preview + approve) is the child /draft route (§11).

const DRAFT_ROUTE = '/admin/settings/document-templates/rtr/draft';

function statusTone(status: TemplateStatus): 'ok' | 'brand' | 'muted' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'DRAFT') return 'brand';
  return 'muted';
}

function fmt(iso: string | null): string {
  if (iso == null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; template: DocumentTemplateView; versions: readonly TemplateVersionView[] }
  | { status: 'empty' }
  | { status: 'error'; message: string };

interface Props {
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly createDraftFn?: typeof createDraftFromActive;
}

export function RtrTemplateDetail({
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  createDraftFn = createDraftFromActive,
}: Props = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, DOC_TEMPLATE_READ_SCOPE);
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useToast();
  const navigate = useNavigate();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID) ?? null;
      if (rtr == null) {
        setLoad({ status: 'empty' });
        return;
      }
      const versions = await listVersionsFn(rtr.id);
      setLoad({ status: 'ready', template: rtr, versions });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load the RTR template.') });
    }
  }, [listTemplatesFn, listVersionsFn]);

  useEffect(() => {
    if (!canRead) return;
    void refetch();
  }, [canRead, refetch]);

  const description = (
    <>
      The representation agreement recruiters send before submitting talent to a client. You govern
      the content; recruiters always send the current approved version.
    </>
  );

  if (!canRead) {
    return (
      <SettingsSection title="Right to Represent" description={description}>
        <Card>
          <SettingHint>
            You don’t have permission to manage document templates. Ask a workspace admin for the
            document-template permission.
          </SettingHint>
        </Card>
      </SettingsSection>
    );
  }

  const backLink = (
    <Link to="/admin/settings/document-templates" className="set-navbtn" data-testid="rtr-detail-back">
      ← All document templates
    </Link>
  );

  async function openDraft(template: DocumentTemplateView, existingDraft: TemplateVersionView | undefined) {
    // An open DRAFT → edit it. Otherwise create vN+1 from the current ACTIVE content
    // (the backend copies it; the one-DRAFT invariant is server-enforced).
    if (existingDraft != null) {
      navigate(DRAFT_ROUTE);
      return;
    }
    setBusy(true);
    try {
      await createDraftFn(template.id);
      navigate(DRAFT_ROUTE);
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not start a new draft. Please try again.'));
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Right to Represent" description={description} actions={backLink}>
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={() => void refetch()} /> : null}
      {load.status === 'empty' ? (
        <Card>
          <EmptyState message="No Right to Represent template exists for this workspace yet." />
          <SettingHint>
            A workspace admin creates the first version from the draft editor. Until an approved
            version exists, recruiters cannot send an RTR.
          </SettingHint>
        </Card>
      ) : null}

      {load.status === 'ready'
        ? (() => {
            const { template, versions } = load;
            const draft = versions.find((v) => v.status === 'DRAFT');
            const active = versions.find((v) => v.id === template.current_version_id);
            // Newest first for the history table.
            const history = [...versions].sort((a, b) => b.version_number - a.version_number);
            return (
              <>
                <Card>
                  <SettingCardHead
                    icon={<IconFile />}
                    title={template.name}
                    sub="Tenant-governed · recruiters send the current approved version"
                  />
                  <div className="set-row">
                    <div className="set-row__l">
                      {active != null ? (
                        <StatChip tone="ok" dot>
                          Approved · v{active.version_number}
                        </StatChip>
                      ) : (
                        <StatChip tone="muted" dot>
                          No approved version yet
                        </StatChip>
                      )}
                      {draft != null ? (
                        <StatChip tone="brand" dot>
                          Draft in progress · v{draft.version_number}
                        </StatChip>
                      ) : null}
                    </div>
                    <div className="set-row__r">
                      {canManage ? (
                        <Button
                          onClick={() => void openDraft(template, draft)}
                          disabled={busy}
                          data-testid="rtr-detail-draft"
                        >
                          {draft != null ? 'Edit draft' : 'Create new draft'}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {!canManage ? (
                    <SettingHint>You can view the RTR template but not change it.</SettingHint>
                  ) : null}
                </Card>

                <Card>
                  <SettingCardHead title="Version history" sub="Historical versions are kept exactly as approved" />
                  <div className="rc-tablewrap">
                  <table className="rc-table" data-testid="rtr-version-history">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Approved on</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((v) => (
                        <tr key={v.id} data-testid={`rtr-version-${v.version_number}`}>
                          <td>v{v.version_number}</td>
                          <td>
                            <StatChip tone={statusTone(v.status)} dot>
                              {v.status === 'ACTIVE' ? 'Approved' : v.status === 'DRAFT' ? 'Draft' : 'Retired'}
                            </StatChip>
                          </td>
                          <td>{fmt(v.created_at)}</td>
                          <td>{fmt(v.activated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </Card>
              </>
            );
          })()
        : null}
    </SettingsSection>
  );
}
