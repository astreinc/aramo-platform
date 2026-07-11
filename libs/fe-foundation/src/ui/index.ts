// libs/fe-foundation — the app-chrome layer, extracted from apps/ats-web at
// Platform-Console Inc-2 PR-1.6 (FE-Foundation Extraction) so platform-web (PR-2)
// can import the richer chrome from scope:shared (the Platform⊥ATS wall forbids
// importing from ats-web). These are the "above-the-frozen-Shell" components the
// mockups need: the collapsible rail/topbar AppShell kit, the account UserMenu,
// the Avatar/EntityCell atoms, the token-styled DataTable, and the icon set.
//
// Domain-neutral (react + react-router only — no @aramo/* domain import). The
// structural CSS ships in ./ui.css (side-effect-imported below); the token
// VARIABLES it consumes stay per-app (see the ui.css header's token contract).
import './ui.css';

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
} from './AppShell';
export { UserMenu } from './UserMenu';
export { Avatar, EntityCell, initialsOf, type AvatarSize } from './Avatar';
export { DataTable } from './DataTable';
// Dashboard tiles — moved from apps/ats-web at Platform-Console Inc-3 PR-3.8 so
// platform-web's operator dashboard can import them across the Platform⊥ATS wall
// (same move-not-fork discipline as the PR-1.6 chrome carve). Domain-neutral
// (react-only); their structural styles ride ./ui.css (the rc-metric/rc-kpi/
// rc-spark/rc-pace rules carved alongside).
export { MetricCard } from './MetricCard';
export { KpiCard, type KpiDelta, type KpiPace } from './KpiCard';
export { Sparkline, type SparkTone } from './Sparkline';
