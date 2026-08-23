import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SIDER_WIDTH, useResponsiveSider } from "./useResponsiveSider";

describe("useResponsiveSider", () => {
  it("starts with the drawer closed", () => {
    const { result } = renderHook(() => useResponsiveSider(true));

    expect(result.current.drawerOpen).toBe(false);
  });

  it("opens the drawer via openDrawer()", () => {
    const { result } = renderHook(() => useResponsiveSider(true));

    act(() => {
      result.current.openDrawer();
    });

    expect(result.current.drawerOpen).toBe(true);
  });

  it("closes the drawer via closeDrawer()", () => {
    const { result } = renderHook(() => useResponsiveSider(true));

    act(() => {
      result.current.openDrawer();
    });
    act(() => {
      result.current.closeDrawer();
    });

    expect(result.current.drawerOpen).toBe(false);
  });

  it("offsets the content by the sider width when not broken (desktop)", () => {
    const { result } = renderHook(() => useResponsiveSider(false));

    expect(result.current.contentMarginLeft).toBe(SIDER_WIDTH);
  });

  it("never offsets the content when broken (mobile) — the menu is a drawer overlay, not a pushed panel", () => {
    const { result } = renderHook(() => useResponsiveSider(true));

    expect(result.current.contentMarginLeft).toBe(0);

    // Opening the drawer must not start pushing content either — this is
    // the exact regression a real device test surfaced against the earlier
    // Sider-collapsedWidth-based design.
    act(() => {
      result.current.openDrawer();
    });
    expect(result.current.contentMarginLeft).toBe(0);
  });

  it("updates contentMarginLeft when the broken flag changes across a re-render", () => {
    const { result, rerender } = renderHook(({ broken }) => useResponsiveSider(broken), {
      initialProps: { broken: false },
    });

    expect(result.current.contentMarginLeft).toBe(SIDER_WIDTH);

    rerender({ broken: true });

    expect(result.current.contentMarginLeft).toBe(0);
  });
});
