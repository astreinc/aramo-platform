import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError } from '../api/client';
import { Button } from '../components/Button';
import { Combobox, type ComboboxItem } from '../components/Combobox';
import { FormField } from '../components/FormField';
import { InlineAlert } from '../components/InlineAlert';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import {
  probeCompanyList,
  type CompanyListState,
  type CompanyPickerView,
} from '../companies/companies-api';

import {
  addTeamClient,
  fetchTeamClients,
  removeTeamClient,
} from './assignments-api';
import {
  messageForAddTeamClient,
  messageForFetchTeamClients,
  messageForRemoveTeamClient,
  type ErrorMessage,
} from './error-messages';
import type { TeamClientOwnershipRow } from './types';

// Settings S5c-3 — Team-clients editor at /teams/:teamId/clients
// (PL-94 §2 ruling 4: sibling sub-route to /teams/:teamId members;
// reached via the "Manage clients →" link in the members view).
//
// PL-94 §2 ruling 2 — THE COMPANY-PICKER MISMATCH:
//   GET /v1/companies is `company:read` + visibility-resolved; the
//   team-clients mutate is `team:manage` + tenant-wide. A team:manage
//   holder with narrow company-visibility may not see every company
//   they can assign. We DOCUMENT the limitation inline (the
//   <CompanyPickerLimitationNote>) and FILE the follow-up
//   `GET /v1/companies/assignable` (NOT built here).
//
// Idempotency (uniform with D + F + S5c-2 precedent):
//   - POST duplicate → SILENT SUCCESS (BE returns existing row).
//   - DELETE 404 → SUCCESS toast at FE (intent satisfied).

interface Props {
  teamIdOverride?: string;
  fetchClientsFn?: (teamId: string) => Promise<{ items: readonly TeamClientOwnershipRow[] }>;
  probeCompanyListFn?: () => Promise<CompanyListState>;
  addFn?: typeof addTeamClient;
  removeFn?: typeof removeTeamClient;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly TeamClientOwnershipRow[] }
  | { status: 'error'; message: string };

interface PendingRemoval {
  readonly companyId: string;
  readonly stage: 'confirm' | 'removing';
}

function companyDisplay(c: CompanyPickerView): {
  label: string;
  description?: string;
} {
  const cityState = [c.city, c.state]
    .filter((v): v is string => v !== null && v.length > 0)
    .join(', ');
  return {
    label: c.name,
    description: cityState.length > 0 ? cityState : undefined,
  };
}

function companiesToItems(
  companyList: CompanyListState,
  clientCompanyIds: ReadonlySet<string>,
): ReadonlyArray<ComboboxItem> {
  if (companyList.state !== 'ready') return [];
  return [...companyList.companies]
    .filter((c) => !clientCompanyIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const d = companyDisplay(c);
      return {
        value: c.id,
        label: d.label,
        description: d.description,
      };
    });
}

function CompanyPickerLimitationNote() {
  return (
    <InlineAlert variant="error">
      Only companies visible to your role are listed. If a company you can
      assign isn’t in this list, ask an admin with broader company
      visibility, or use the user-ID fallback to paste a company ID.
    </InlineAlert>
  );
}

export function TeamClientsView({
  teamIdOverride,
  fetchClientsFn,
  probeCompanyListFn,
  addFn,
  removeFn,
}: Props = {}) {
  const params = useParams<{ teamId?: string }>();
  const teamId = teamIdOverride ?? params.teamId ?? '';

  const fetchClientsFun = fetchClientsFn ?? fetchTeamClients;
  const probeFun = probeCompanyListFn ?? probeCompanyList;
  const addFun = addFn ?? addTeamClient;
  const removeFun = removeFn ?? removeTeamClient;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [companies, setCompanies] = useState<CompanyListState>({ state: 'forbidden' });
  const [pickerValue, setPickerValue] = useState<string | null>(null);
  const [uuidInput, setUuidInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<ErrorMessage | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchClientsFun(teamId)
      .then((view) => setState({ status: 'ready', rows: view.items }))
      .catch((err: unknown) => {
        const msg = messageForFetchTeamClients(err);
        setState({ status: 'error', message: msg.title });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchClientsFun(teamId)
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', rows: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchTeamClients(err);
        setState({ status: 'error', message: msg.title });
      });
    probeFun()
      .then((next) => {
        if (cancelled) return;
        setCompanies(next);
      })
      .catch(() => {
        if (cancelled) return;
        setCompanies({ state: 'forbidden' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchClientsFun, probeFun, teamId]);

  const companyById = useMemo(() => {
    const m = new Map<string, CompanyPickerView>();
    if (companies.state === 'ready') {
      for (const c of companies.companies) m.set(c.id, c);
    }
    return m;
  }, [companies]);

  const clientCompanyIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') {
      for (const r of state.rows) s.add(r.company_id);
    }
    return s;
  }, [state]);

  const comboboxItems = useMemo(
    () => companiesToItems(companies, clientCompanyIds),
    [companies, clientCompanyIds],
  );

  const onAdd = async () => {
    const targetCompanyId =
      companies.state === 'ready' ? pickerValue : uuidInput.trim();
    if (targetCompanyId === null || targetCompanyId.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await addFun({ teamId, body: { company_id: targetCompanyId } });
      toast.show('Client company added.');
      setPickerValue(null);
      setUuidInput('');
      refresh();
    } catch (err: unknown) {
      setAddError(messageForAddTeamClient(err));
    } finally {
      setAdding(false);
    }
  };

  const onConfirmRemove = async () => {
    if (pendingRemoval === null) return;
    const companyId = pendingRemoval.companyId;
    setPendingRemoval({ companyId, stage: 'removing' });
    try {
      await removeFun({ teamId, companyId });
      toast.show('Client company removed.');
      setPendingRemoval(null);
      refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        toast.show('Client company already removed.');
        setPendingRemoval(null);
        refresh();
        return;
      }
      toast.show(messageForRemoveTeamClient(err).title);
      setPendingRemoval(null);
    }
  };

  const canAdd =
    !adding &&
    ((companies.state === 'ready' && pickerValue !== null) ||
      (companies.state !== 'ready' && uuidInput.trim().length > 0));

  return (
    <section>
      <PageHeader
        title="Team clients"
        description="Client companies owned by this team."
      />
      <Link to="/teams" className="tc-helper" data-testid="back-to-teams">
        ← Back to teams
      </Link>
      {state.status === 'loading' && (
        <p className="tc-helper">Loading client companies…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <>
          {companies.state === 'ready' && (
            <CompanyPickerLimitationNote />
          )}
          <div className="tc-add-member">
            {companies.state === 'ready' ? (
              <div className="tc-add-member__picker">
                <Combobox
                  items={comboboxItems}
                  value={pickerValue}
                  onSelect={(item) => setPickerValue(item.value)}
                  placeholder="Select a company to add…"
                  emptyMessage="No remaining companies."
                  ariaLabel="Add a client company"
                  disabled={adding}
                  testId="add-client-combobox"
                />
              </div>
            ) : (
              <FormField
                label={<label htmlFor="add-client-uuid">Company ID</label>}
                helper="Company list unavailable to your role — paste the UUID."
              >
                <input
                  id="add-client-uuid"
                  type="text"
                  className="tc-input"
                  value={uuidInput}
                  disabled={adding}
                  onChange={(ev) => setUuidInput(ev.target.value)}
                  data-testid="add-client-uuid-input"
                />
              </FormField>
            )}
            <Button
              onClick={onAdd}
              disabled={!canAdd}
              data-testid="add-client-submit"
            >
              {adding ? 'Adding…' : 'Add client'}
            </Button>
          </div>
          {addError !== null && (
            <InlineAlert variant="error">
              <strong>{addError.title}</strong>
              {addError.detail !== undefined && (
                <>
                  <br />
                  {addError.detail}
                </>
              )}
            </InlineAlert>
          )}
          {state.rows.length === 0 ? (
            <div className="tc-tree-empty">
              <p className="tc-helper">No client companies yet.</p>
            </div>
          ) : (
            <ul className="tc-member-list" aria-label="Team client companies">
              {state.rows.map((r) => {
                const c = companyById.get(r.company_id);
                const name = c?.name ?? r.company_id;
                const sub =
                  c !== undefined
                    ? [c.city, c.state]
                        .filter((v): v is string => v !== null && v.length > 0)
                        .join(', ')
                    : '';
                const added = new Date(r.assigned_at).toLocaleDateString();
                const isPending = pendingRemoval?.companyId === r.company_id;
                return (
                  <li
                    key={r.id}
                    className="tc-member-list__row"
                    data-testid={`client-row-${r.company_id}`}
                  >
                    <div>
                      <div className="tc-member-list__name">{name}</div>
                      {sub.length > 0 && (
                        <div className="tc-member-list__email">{sub}</div>
                      )}
                    </div>
                    <span className="tc-member-list__added">Added {added}</span>
                    <div className="tc-member-list__actions">
                      {isPending ? (
                        <>
                          <span className="tc-helper">Remove?</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={onConfirmRemove}
                            disabled={pendingRemoval?.stage === 'removing'}
                            data-testid={`confirm-remove-client-${r.company_id}`}
                          >
                            {pendingRemoval?.stage === 'removing'
                              ? 'Removing…'
                              : 'Confirm'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingRemoval(null)}
                            disabled={pendingRemoval?.stage === 'removing'}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPendingRemoval({
                              companyId: r.company_id,
                              stage: 'confirm',
                            })
                          }
                          data-testid={`remove-client-${r.company_id}`}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
