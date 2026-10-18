// The shared rail collapse preference moved to @aramo/fe-foundation
// (unified multi-product shell; move-not-fork). Same key (`aramo.nav.collapsed`),
// same behaviour; re-exported here so ATS call-sites are unchanged.
export {
  NAV_COLLAPSED_KEY,
  NavCollapseProvider,
  readNavCollapsed,
  useCompactRailPage,
  useNavCollapse,
  type NavCollapse,
} from '@aramo/fe-foundation';
