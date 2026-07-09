// libs/fe-foundation — the domain-neutral FE foundation (originally extracted
// from apps/tenant-console at Recruiter R0). Consumed by apps/ats-web — the
// single unified console (recruiter surface + the /admin section) after the FE
// Consolidation (Directive 5) retired tenant-console — via the
// @aramo/fe-foundation barrel. The lib carries NO domain knowledge
// (Radix + react + react-router only — no @aramo/* domain import).

// Side-effect CSS: theme tokens + fonts moved into the lib (Q1 ruling)
// so consumers inherit the visual identity automatically.
import './design/tokens.css';
import './design/fonts.css';

// api
export { apiClient, ApiClient, ApiError } from './api/client';
export type { ApiClientOptions } from './api/client';

// auth
export {
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_PATH,
  fetchSession,
  logout,
  redirectToLogin,
  useSession,
} from './auth/session';
export type { Session, SessionState } from './auth/session';
export { hasScope } from './auth/scopes';
export { RouteGuard } from './auth/RouteGuard';

// components (the existing components/index.ts barrel also side-effect-
// imports components.css)
export {
  Button,
  Card,
  Combobox,
  Dialog,
  DialogClose,
  ForbiddenState,
  FormField,
  InlineAlert,
  Label,
  NavLink,
  PageHeader,
  RadioGroup,
  Switch,
  Table,
  Tabs,
  ToastProvider,
  useToast,
} from './components';
export type {
  ComboboxItem,
  ComboboxProps,
  RadioOption,
  TableColumn,
  TabItem,
} from './components';

// shell (the thin frozen Shell — retained; superseded by ./ui AppShell)
export { Shell } from './shell/Shell';
export type { ShellNavItem } from './shell/Shell';

// ui — the extracted app-chrome layer (PR-1.6): AppShell kit, UserMenu, Avatar,
// DataTable. Side-effect-imports ./ui/ui.css.
export * from './ui';
// icons — both the named set (import { IconX }) and the Icons namespace
// (import { Icons }; Icons.IconX), matching ats-web's two icon consumption
// surfaces so the re-point is a pure import-path change.
export * from './ui/icons';
export * as Icons from './ui/icons';
