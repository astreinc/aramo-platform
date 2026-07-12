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

// ── DataTable — extracted to @aramo/fe-foundation (PR-1.6) ──
export { DataTable, type TableColumn } from '@aramo/fe-foundation';

// ── Chrome — extracted to @aramo/fe-foundation (PR-1.6) ──
export {
  AppShell,
  ShellBrand,
  Rail,
  RailNavItem,
  RailNavLabel,
  RailUser,
  TopBar,
  Breadcrumb,
  CmdKSearch,
  NotificationButton,
  type BreadcrumbItem,
} from '@aramo/fe-foundation';

// ── New: surface + content atoms ──
export { Card, CardHead } from './Card';
// Avatar/EntityCell + UserMenu extracted to @aramo/fe-foundation (PR-1.6).
export { Avatar, EntityCell, initialsOf, type AvatarSize } from '@aramo/fe-foundation';
export { TitleCell } from './TitleCell';
export { UserMenu } from '@aramo/fe-foundation';
export {
  StatusPill,
  StagePill,
  BandPill,
  Tag,
  TagList,
  ConstraintChip,
  type PillTone,
  type ConstraintState,
} from './pills';
export {
  PRESENTATION_BANDS,
  bandTone,
  bandLabel,
  type PresentationBand,
} from './band-map';
// MetricCard/KpiCard/Sparkline moved to @aramo/fe-foundation at Inc-3 PR-3.8
// (move-not-fork; the tiles now serve platform-web's dashboard too). ats-web
// re-inherits them through the barrel — call-sites (../ui) are unchanged.
export {
  MetricCard,
  KpiCard,
  type KpiDelta,
  type KpiPace,
  Sparkline,
  type SparkTone,
} from '@aramo/fe-foundation';
export { HotToggle } from './HotToggle';
export {
  ActionItem,
  type ActionKind,
  type ActionPriority,
} from './ActionItem';
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

// ── Icons — extracted to @aramo/fe-foundation (PR-1.6); re-exported as the
// same `Icons` namespace so `import { Icons } from '../ui'` call-sites are
// untouched. ──
export { Icons } from '@aramo/fe-foundation';
