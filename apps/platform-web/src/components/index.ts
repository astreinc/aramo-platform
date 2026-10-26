// PLATFORM-UX-1 F-1 (directive R-3) — the NEW platform-web components. Local to
// platform-web; promoting any of them to fe-foundation needs a later ruling.
export { AccessDenied, type AccessDeniedProps } from './AccessDenied';
export { ChainPreview, type ChainPreviewProps } from './ChainPreview';
export {
  CommercialRequestDialog,
  RequestField,
  typedTokenMatches,
  type CommercialCommitTone,
  type CommercialDiffRow,
  type CommercialRequestDialogProps,
  type RequestFieldProps,
} from './CommercialRequestDialog';
export { ConfirmDialog, type ConfirmDialogProps, type ConfirmTone } from './ConfirmDialog';
export {
  FieldAck,
  FieldSelect,
  FieldText,
  FieldTextArea,
  type FieldAckProps,
  type FieldSelectOption,
  type FieldSelectProps,
  type FieldTextAreaProps,
  type FieldTextProps,
} from './ConfirmFields';
export { DetailDrawer, type DetailDrawerProps } from './DetailDrawer';
export { DiffView, type DiffKind, type DiffRow, type DiffViewProps } from './DiffView';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { EnvironmentBar, type EnvironmentBarProps, type EnvironmentContext } from './EnvironmentBar';
export { FilterBar, SegmentedFilter, type FilterBarProps, type SegmentOption, type SegmentedFilterProps } from './FilterBar';
export { LifecycleActionMenu, type LifecycleActionMenuProps, type LifecycleMenuAction } from './LifecycleActionMenu';
export { OneTimeSecret, type OneTimeSecretProps } from './OneTimeSecret';
export {
  Pill,
  TENANT_STATUS_PILL,
  tenantStatusPill,
  type PillProps,
  type PillSize,
  type PillSpec,
  type PlatformTone,
} from './Pill';
export { Skeleton, SkeletonPanel, type SkeletonPanelProps, type SkeletonProps } from './Skeleton';
export { Stepper, type StepperProps } from './Stepper';
export { TagInput, type TagInputProps } from './TagInput';
export { Timeline, shortId, type TimelineEvent, type TimelineProps } from './Timeline';
export { TypedConfirm, typedConfirmMatches, type TypedConfirmProps } from './TypedConfirm';
export { ViewOnlyNote, type ViewOnlyNoteProps } from './ViewOnlyNote';
export {
  daysAgo,
  formatClock,
  formatDate,
  formatDateRelative,
  formatRelative,
  formatTimestamp,
} from './format-date';
export {
  COMMERCIAL_PERMISSIONS,
  PERMISSION_LABEL,
  PLATFORM_PERMISSIONS,
  permissionLabel,
  type CommercialPermission,
  type PlatformPermission,
} from './permissions';
// CCP-B1 — the NEW CCP components (CCP-UI v1.0 handoff §6; R-3).
export { ApprovalChain, ChainProgress, type ApprovalChainProps, type ApprovalChainStep, type ChainProgressProps, type ChainStepState } from './ApprovalChain';
export { BeforeAfterDiff, type BeforeAfterDiffProps, type BeforeAfterRow } from './BeforeAfterDiff';
export { BootstrapBanner, type BootstrapBannerProps } from './BootstrapBanner';
export { CrStepper, type CrStep, type CrStepMark, type CrStepperProps } from './CrStepper';
export { EligibilityVerdict, RosterVerdicts, type EligibilityVerdictProps, type RosterVerdict, type RosterVerdictsProps } from './EligibilityVerdict';
// CCP-B6 — the NEW support-extension components (CCP-UI v1.0 handoff §6 ExceptionOverlay; §5.10).
export { ExceptionOverlay, type ExceptionOverlayProps, type ExceptionOverlayRow } from './ExceptionOverlay';
export {
  SupportField,
  SupportRequestDialog,
  type SupportChain,
  type SupportCommitTone,
  type SupportFieldProps,
  type SupportPreview,
  type SupportRequestDialogProps,
} from './SupportRequestDialog';
// CCP-UI-V12 — the NEW v1.1 / v1.2 components (CCP-UI v1.1 handoff §13.10; v1.2 §17.4; R-3).
export { ApplyDeadline, applyDeadlineText, type ApplyDeadlineProps, type ApplyDeadlineState, type ApplyDeadlineText } from './ApplyDeadline';
export { ExceptionCountTile, type ExceptionCountTileProps } from './ExceptionCountTile';
export { NotEnabledState, TAX_NOT_ENABLED, type NotEnabledStateProps } from './NotEnabledState';
export { PaymentDueIndicator, paymentDueState, type PaymentDueIndicatorProps, type PaymentDueState } from './PaymentDueIndicator';
export { RenewalRemainingPill, daysLeft, renewalRemaining, type RenewalRemainingPillProps } from './RenewalRemainingPill';
export { UsageReconBanner, type UsageReconBannerProps, type UsageReconStatus, type UsageRunMode } from './UsageReconBanner';
export {
  WithdrawFailedActivationDialog,
  WITHDRAW_REFUSAL,
  type WithdrawFailedActivationDialogProps,
  type WithdrawOutcome,
} from './WithdrawFailedActivationDialog';
export { WithheldAmount, WITHHELD_ARIA, WITHHELD_TOOLTIP, type WithheldAmountProps, type WithheldAmountReason } from './WithheldAmount';
export { WithheldPrice, withheldPriceReason, type WithheldPriceProps, type WithheldPriceReason } from './WithheldPrice';
