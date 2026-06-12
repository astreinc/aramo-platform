import { useState } from 'react';

import { PIPELINE_STATUS_VALUES } from '../pipeline/types';

import {
  ActionItem,
  ActivityFeed,
  AppShell,
  AttestCheckbox,
  Avatar,
  Breadcrumb,
  Button,
  Card,
  CardHead,
  CmdKSearch,
  ConstraintChip,
  DataTable,
  EntityCell,
  FilterChip,
  Icons,
  MetricCard,
  NotificationButton,
  ProgressMini,
  Rail,
  RailNavItem,
  RailNavLabel,
  RailUser,
  ReservedSeam,
  ScopedSearch,
  StagePill,
  StatusPill,
  Stepper,
  TagList,
  Toolbar,
  TopBar,
  type TableColumn,
} from './index';

// UiGallery — the Phase 1 base-set showcase (Storybook substitute; no
// Storybook in this repo). Rendered at /ui-gallery in DEV only. Demonstrates
// every base component in the Confident Blue grammar, in chrome. Canonical
// vocab throughout (Requisitions / Talent), per Lead ruling F2.

interface DemoRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly stage: (typeof PIPELINE_STATUS_VALUES)[number];
  readonly location: string;
}

const DEMO_ROWS: readonly DemoRow[] = [
  { id: '1', name: 'Marcus Adeyemi', role: 'Staff Engineer', stage: 'interviewing', location: 'Austin, TX' },
  { id: '2', name: 'Sofia Ramos', role: 'Senior Backend', stage: 'submitted', location: 'Remote (US)' },
  { id: '3', name: 'Diego Martín', role: 'Backend Engineer', stage: 'qualifying', location: 'Remote (US)' },
  { id: '4', name: 'Nisha Patel', role: 'Senior SWE', stage: 'placed', location: 'Chicago, IL' },
];

const TABLE_COLUMNS: ReadonlyArray<TableColumn<DemoRow>> = [
  {
    key: 'talent',
    header: 'Talent',
    render: (r) => <EntityCell name={r.name} subtitle={r.role} />,
  },
  { key: 'stage', header: 'Stage', render: (r) => <StagePill status={r.stage} /> },
  { key: 'location', header: 'Location', render: (r) => r.location },
  {
    key: 'skills',
    header: 'Skills',
    render: () => <TagList tags={['Rust', 'Distributed', 'AWS', 'Kafka']} />,
  },
];

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--faint)', fontWeight: 600, margin: '0 0 12px' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const ENGAGEMENT_STEPS = [
  'Surfaced',
  'Engaged',
  'Awaiting response',
  'Responded',
  'In conversation',
  'Ready for submittal',
  'Submitted',
];

export function UiGallery() {
  const [filter, setFilter] = useState('all');
  const [attest, setAttest] = useState<[boolean, boolean, boolean]>([
    false,
    false,
    false,
  ]);
  const allChecked = attest.every(Boolean);

  const rail = (
    <Rail
      brand="Aramo · Recruiter"
      user={<RailUser initials="PN" name="Priya Nair" role="Senior recruiter" />}
    >
      <RailNavItem icon={<Icons.IconDesk />} label="My desk" active />
      <RailNavItem icon={<Icons.IconRequisitions />} label="Requisitions" count={12} />
      <RailNavItem icon={<Icons.IconTalent />} label="Talent" />
      <RailNavItem icon={<Icons.IconCompanies />} label="Companies" />
      <RailNavItem icon={<Icons.IconContacts />} label="Contacts" />
      <RailNavLabel>Work</RailNavLabel>
      <RailNavItem icon={<Icons.IconTasks />} label="Tasks" count={5} />
      <RailNavItem icon={<Icons.IconActivity />} label="Activity" />
    </Rail>
  );

  const topBar = (
    <TopBar>
      <Breadcrumb items={[{ label: 'Design system' }, { label: 'Base components' }]} />
      <CmdKSearch />
      <NotificationButton hasUnread />
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>
        Confident Blue — base components
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        Phase 1 design system. Frozen primitives themed via token re-map; new
        components built above the freeze.
      </p>

      <Section title="Buttons (frozen, themed)">
        <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Default</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </Section>

      <Section title="Metric cards (no deltas/goals — gap #6)">
        <div className="rc-metrics">
          <MetricCard icon={<Icons.IconRequisitions />} label="Open reqs" value="12" hint="2 hot" />
          <MetricCard icon={<Icons.IconTalent />} label="Talent" value="47" />
          <MetricCard icon={<Icons.IconTasks />} label="Tasks" value="5" />
          <MetricCard icon={<Icons.IconActivity />} label="Activity (7d)" value="31" />
        </div>
      </Section>

      <Section title="Status pills + stage pills (11-state → tone map)">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <StatusPill tone="ok" dot>
            Open
          </StatusPill>
          <StatusPill tone="hot" icon={<Icons.IconFlame />}>
            Hot
          </StatusPill>
          <StatusPill tone="neutral">Intake</StatusPill>
          <StatusPill tone="brand">Submitted</StatusPill>
          <StatusPill tone="danger">Closed</StatusPill>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PIPELINE_STATUS_VALUES.map((s) => (
            <StagePill key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section title="Avatars + entity cell">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Avatar name="Marcus Adeyemi" size="sm" />
          <Avatar name="Sofia Ramos" size="md" />
          <Avatar name="Diego Martín" size="lg" />
          <EntityCell name="Aisha Khan" subtitle="SRE · Rust, Kubernetes" hot />
        </div>
      </Section>

      <Section title="DataTable (frozen Table, themed dense)">
        <Card flush>
          <Toolbar>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </FilterChip>
            <FilterChip active={filter === 'mine'} onClick={() => setFilter('mine')}>
              Only mine
            </FilterChip>
            <FilterChip active={filter === 'hot'} onClick={() => setFilter('hot')}>
              Only hot
            </FilterChip>
            <ScopedSearch placeholder="Search your talent" />
          </Toolbar>
          <DataTable<DemoRow>
            columns={TABLE_COLUMNS}
            rows={DEMO_ROWS}
            rowKey={(r) => r.id}
            emptyMessage="No talent in this working set."
          />
        </Card>
      </Section>

      <div className="rc-grid2">
        <div>
          <Section title="Action items (My-desk aggregation — gap #7)">
            <Card flush>
              <CardHead title="Needs you today" actions={<a className="rc-card__head-more" href="#root">View all</a>} />
              <ActionItem
                kind="due"
                title="Client call — Marcus Adeyemi"
                context={
                  <>
                    <b>Senior Rust Engineer</b> · Northwind Robotics · in 2 hours
                  </>
                }
                time="Due 11:00"
                action={<Button variant="secondary" size="sm">Open</Button>}
              />
              <ActionItem
                kind="reply"
                title="Sofia Ramos replied"
                context="“Yes, happy to talk Thursday afternoon…”"
                time="5h ago"
                action={<Button variant="secondary" size="sm">Reply</Button>}
              />
              <ActionItem
                kind="overdue"
                title="Follow-up overdue — James Cho"
                context="Submitted to client 6 days ago, no response logged"
                time="Overdue"
                action={<Button variant="secondary" size="sm">Nudge</Button>}
              />
              <ActionItem
                kind="task"
                title="Send Aisha Khan’s references to D. Okafor"
                context="Task · Senior Rust Engineer"
                time="Today"
                action={<Button variant="secondary" size="sm">Do it</Button>}
              />
            </Card>
          </Section>

          <Section title="Constraint chips (non-examination uses only — gap #4)">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
              <ConstraintChip state="pass" label="Rate" value="Within max" />
              <ConstraintChip state="pass" label="Work auth" value="Authorized" />
              <ConstraintChip state="partial" label="Location" value="Remote · confirm" />
              <ConstraintChip state="fail" label="Availability" value="Unknown" />
            </div>
          </Section>

          <Section title="Attestation checkboxes (gate friction)">
            <AttestCheckbox checked={attest[0]} onChange={(v) => setAttest([v, attest[1], attest[2]])}>
              I confirm I have communicated directly with this talent and they are interested in this role.
            </AttestCheckbox>
            <AttestCheckbox checked={attest[1]} onChange={(v) => setAttest([attest[0], v, attest[2]])}>
              I confirm the rate, availability, and authorization details have been validated.
            </AttestCheckbox>
            <AttestCheckbox checked={attest[2]} onChange={(v) => setAttest([attest[0], attest[1], v])}>
              I confirm this talent is ready for submission to the client.
            </AttestCheckbox>
            <Button variant="primary" disabled={!allChecked}>
              Submit to client
            </Button>
          </Section>
        </div>

        <aside>
          <Section title="Stepper (engagement state)">
            <Card>
              <Stepper steps={ENGAGEMENT_STEPS} currentIndex={3} />
            </Card>
          </Section>

          <Section title="Progress mini">
            <Card>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ProgressMini value={14} max={20} count={14} ariaLabel="Pipeline size" />
                <ProgressMini value={1} max={3} ariaLabel="Openings filled" />
              </div>
            </Card>
          </Section>

          <Section title="Activity feed">
            <Card>
              <ActivityFeed
                items={[
                  { id: 'a', text: <><b>You</b> moved Marcus to Interview</>, when: '2h ago' },
                  { id: 'b', text: 'Sofia Ramos replied to your message', when: '5h ago' },
                  { id: 'c', text: <><b>Tom</b> submitted Aisha to client</>, when: '2d ago' },
                ]}
              />
            </Card>
          </Section>

          <Section title="Reserved seam (R10 — no scores)">
            <ReservedSeam />
          </Section>
        </aside>
      </div>
    </AppShell>
  );
}
