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
  MICROSOFT_SIGN_OUT_URL,
  SESSION_PATH,
  TENANT_ACCESS_DENIED_PATH,
  accessDeniedPath,
  currentReturnTo,
  fetchSession,
  loginUrl,
  logout,
  redirectToAccessDenied,
  redirectToLogin,
  signInPageUrl,
  useSession,
} from './auth/session';
export type { FederatedIdp, LoginOptions, Session, SessionState } from './auth/session';
// AUTH-SIGNIN-1 §3.2 — the shared Aramo sign-in screen.
export { SignInPage, allowedConsumer, providersFrom, safeReturnTo } from './auth/SignInPage';
export { AUTH_PRODUCTS, AuthShell } from './auth/AuthShell';
export type { AuthProduct } from './auth/AuthShell';
export type { SignInErrorCopy, SignInPageProps } from './auth/SignInPage';
// Inc-2 PR-2 — single auth-consumer bootstrap point (default 'recruiter';
// platform-web calls this with 'platform'). Parameterizes the /auth/:consumer/*
// paths in session.ts + api/client.ts.
export { configureAuthConsumer, getAuthConsumer, configureAppBasePath, getAppBasePath, appPath } from './auth/consumer';
export { hasScope } from './auth/scopes';
export { RouteGuard } from './auth/RouteGuard';

// components (the existing components/index.ts barrel also side-effect-
// imports components.css)
export {
  Button,
  Card,
  Checkbox,
  Combobox,
  Dialog,
  DialogClose,
  ForbiddenState,
  FormField,
  Input,
  TextArea,
  Select,
  TextField,
  InlineAlert,
  Label,
  NavLink,
  PageHeader,
  RadioGroup,
  SignedOut,
  WrongAccountRecovery,
  Switch,
  Table,
  Tabs,
  ToastProvider,
  useToast,
  useOptionalToast,
} from './components';
export type {
  CheckboxProps,
  ComboboxItem,
  ComboboxProps,
  InputProps,
  TextAreaProps,
  SelectProps,
  TextFieldProps,
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
// format — D-ORG-3: the shared date/instant formatters (moved from ats-web).
export { formatDate, formatInstant } from './format/date';
// Unified multi-product shell — the shared rail + page grid + collapse preference
// (moved from apps/ats-web), the app switcher, the product-availability client
// (moved from apps/home-web) and the cross-app return context.
export { AramoAppShell } from './aramo-shell/AramoAppShell';
export { AramoRail, type AramoRailItem, type AramoRailProps, type AramoRailSection } from './aramo-shell/AramoRail';
export {
  NAV_COLLAPSED_KEY,
  NavCollapseProvider,
  readNavCollapsed,
  useCompactRailPage,
  useNavCollapse,
  type NavCollapse,
} from './aramo-shell/nav-collapse';
export { AppSwitcher, type AppSwitcherItem } from './ui/AppSwitcher';
export type { UserMenuItem } from './ui/UserMenu';
export {
  MY_PRODUCTS_PATH,
  fetchMyProducts,
  productByKey,
  productEntryHref,
  orgAccessOf,
  ssoEntryHref,
  PRODUCT_CONSUMER,
  useMyProducts,
  type ProductAvailability,
  type ProductAvailabilityView,
  type ProductKey,
  type ProductUnavailableReason,
  type ProductsState,
  type OrgAccess,
} from './platform/products';
export { buildAppSwitcherItems, type AramoAppKey } from './platform/app-switcher-items';
export {
  clearReturnContext,
  orgHref,
  orgEntryHref,
  parseReturnContext,
  readRememberedReturnContext,
  rememberReturnContext,
  validReturnPath,
  trustedSignOrigin,
  SIGN_SETTINGS_PATH_PREFIX,
  type ReturnApp,
  type ReturnContext,
  type ReturnValidationOptions,
} from './navigation/return-context';

