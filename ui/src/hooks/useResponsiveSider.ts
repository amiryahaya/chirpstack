import { useState } from "react";

// Width of the persistent sidebar on desktop.
export const SIDER_WIDTH = 300;

// Width of the mobile drawer.
export const DRAWER_WIDTH = 280;

// Manages the mobile nav drawer's open/closed state and the content area's
// compensating left margin. Deliberately does NOT detect "broken" (below
// breakpoint) itself — that's antd's own `Grid.useBreakpoint()`, called by
// the component and passed in here. Keeping breakpoint detection out of
// this hook keeps it a pure, easily-testable state machine, and avoids an
// earlier design mistake: driving both antd's `Layout.Sider` `collapsed`
// prop AND a custom re-open control off the same state fought antd's own
// responsive auto-collapse logic, which keeps re-asserting `collapsed=true`
// while the viewport stays below the breakpoint. A `Drawer` with its own
// independent open state — never touching Sider's `collapsed` at all —
// sidesteps that fight entirely.
export function useResponsiveSider(broken: boolean) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return {
    drawerOpen,
    openDrawer: () => setDrawerOpen(true),
    closeDrawer: () => setDrawerOpen(false),
    // On mobile the menu is a drawer that overlays content — it must never
    // push it via a margin, regardless of open/closed state.
    contentMarginLeft: broken ? 0 : SIDER_WIDTH,
  };
}
