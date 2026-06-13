// Aramo Recruiter Console — Confident Blue design system (Phase 1).
//
// The base component set. Two kinds of export:
//   • FROZEN-THEMED: re-exported from @aramo/fe-foundation, rebranded purely
//     by the theme.css token re-map (Button, Card primitives, Table→DataTable,
//     Dialog, Combobox, FormField, …). No new component, no lib edit.
//   • NEW: app-layer presentational components built ABOVE the freeze where a
//     frozen primitive structurally cannot express the target design.
//
// CSS for the new components ships in ./ui.css; the token layer in ./theme.css.
// Both are imported once in main.tsx after the fe-foundation barrel.

// ── Frozen primitives, themed (re-exported for one import surface) ──
export {
  Button,
  Card as FoundationCard,
  Dialog,
  Combobox,
  FormField,
  InlineAlert,
  Label,
  PageHeader,
  Switch,
  RadioGroup,
} from '@aramo/fe-foundation';

// ── DataTable (frozen Table, themed dense) ──
export { DataTable, type TableColumn } from './DataTable';

// ── New: chrome ──
export {
  AppShell,
  Rail,
  RailNavItem,
  RailNavLabel,
  RailUser,
  TopBar,
  Breadcrumb,
  CmdKSearch,
  NotificationButton,
  type BreadcrumbItem,
} from './AppShell';

// ── New: surface + content atoms ──
export { Card, CardHead } from './Card';
export { Avatar, EntityCell, initialsOf, type AvatarSize } from './Avatar';
export { TitleCell } from './TitleCell';
export {
  StatusPill,
  StagePill,
  Tag,
  TagList,
  ConstraintChip,
  type PillTone,
  type ConstraintState,
} from './pills';
export { MetricCard } from './MetricCard';
export { ActionItem, type ActionKind } from './ActionItem';
export { Stepper } from './Stepper';
export { ProgressMini } from './ProgressMini';
export { AttestCheckbox } from './AttestCheckbox';
export { Toolbar, FilterChip, ScopedSearch } from './Toolbar';
export { ActivityFeed, type ActivityFeedItem } from './ActivityFeed';
export { ReservedSeam } from './ReservedSeam';

// ── Stage projection (single source: ../pipeline/types) ──
export {
  stageTone,
  stageLabel,
  funnelBucket,
  funnelCounts,
  FUNNEL_BUCKETS,
  type StageTone,
  type FunnelBucketKey,
} from './stage-map';

// ── Icons ──
export * as Icons from './icons';
