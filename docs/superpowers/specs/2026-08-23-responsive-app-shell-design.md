# Responsive App Shell (Phase 1 of Frontend Responsiveness) — Design Spec

Date: 2026-08-23
Status: Approved for implementation
Tracks: GitHub issue #2 ("Web frontend is not responsive on smaller/multiple
device sizes"), decomposed into phases. This spec covers **Phase 1 only**:
the persistent app shell (sidebar, header, content area). Table pages
(Phase 2), form pages (Phase 3), and the map component (Phase 4) are
out of scope here and tracked as follow-up work.

## Summary

Make the app shell — sidebar navigation, header, and content wrapper —
usable on narrow viewports. Currently the sidebar is a fixed 300px column
that never collapses, and the header's search box has a hardcoded 500px
width; together these make the app unusable below roughly tablet width.

## Investigated current state

- `ui/src/App.tsx:81`: `<Layout.Sider width="300" theme="light"
  className="layout-menu">` — no `breakpoint`, `collapsible`, or
  `collapsedWidth` props. Never collapses.
- `ui/src/index.css:1-3`: `.layout { margin-left: 300px; }` — a **separate**
  hardcoded rule compensating for `.layout-menu`'s `position: fixed`
  (`index.css:34`), which takes the sider out of normal document flow.
  This means collapsing the Sider alone is not enough — this margin must
  also become responsive, driven by the same collapsed state, or the
  content area stays offset by 300px even after the sidebar hides.
- `ui/src/index.css:51-53`: `.layout-content { margin-top: 65px; }` plus
  `App.tsx:84`'s inline `style={{ padding: "24px 24px 24px" }}` — fixed
  spacing, no narrow-viewport adjustment.
- `ui/src/components/Header.tsx:165`: the search `AutoComplete` has
  `style={{ width: 500, lineHeight: "32px" }}` — a hardcoded 500px width
  that alone exceeds most phone viewport widths. `.layout-header .actions`
  (`index.css:21-28`) lays out its children (search, help, user menu) via
  `float: right`, which does not wrap or shrink.
- antd version in use: 6.5.2. `Layout.Sider` in this version natively
  supports `breakpoint` (`xs`/`sm`/`md`/`lg`/`xl`/`xxl`/`xxxl`) +
  `collapsedWidth` (setting it to `0` makes antd render its own floating
  "special trigger" button automatically, no custom hamburger/drawer
  needed) + controlled `collapsed`/`onCollapse`. Confirmed via antd's own
  docs (context7, `/ant-design/ant-design/6.5.0`).
- No CSS media queries exist anywhere in `ui/src` today (`index.css` is
  the only global stylesheet, 141 lines, zero `@media` rules).

## Design

**Sidebar** (`App.tsx`): add controlled collapse state and antd's native
responsive props:
```tsx
const [collapsed, setCollapsed] = useState(false);
...
<Layout.Sider
  width={300}
  collapsedWidth={0}
  collapsible
  breakpoint="lg"
  collapsed={collapsed}
  onCollapse={(c) => setCollapsed(c)}
  theme="light"
  className="layout-menu"
>
```
Below the `lg` breakpoint (992px), the sider auto-collapses to 0 width;
antd's built-in zero-width trigger appears to reopen it. Above `lg`, it
behaves exactly as today (persistent 300px sidebar, `collapsible` doesn't
change that since it starts uncollapsed and only antd's own breakpoint
logic or the trigger toggles it).

**Content offset** (`index.css` + `App.tsx`): remove the hardcoded
`.layout { margin-left: 300px; }` CSS rule and replace it with an inline
style on the `.layout` wrapper driven by the *same* `collapsed` state:
```tsx
<Layout className="layout" style={{ marginLeft: collapsed ? 0 : 300 }}>
```
This guarantees the content offset and the sidebar's actual width can
never drift out of sync with each other (both come from one state
variable and the same `300`/`0` values used for the Sider's own
`width`/`collapsedWidth`), rather than depending on a hand-maintained CSS
breakpoint that would need to be kept in sync with antd's `breakpoint="lg"`
value by hand.

**Header spacing**: add a small `@media (max-width: 991px)` block to
`index.css` (991px = one pixel below antd's `lg` breakpoint, so it
activates in exactly the same viewport range the sider auto-collapses in)
reducing `Layout.Content`'s padding and `.layout-header`/`.layout-content`
top offsets modestly on narrow screens. Kept as plain CSS since this is
pure spacing with no layout-branching logic — no need to introduce antd's
JS `useBreakpoint()` hook for this.

**Header search box** (`Header.tsx`): change the `AutoComplete`'s
hardcoded `style={{ width: 500, ... }}` to `style={{ width: "100%",
maxWidth: 500, ... }}`, and give `.layout-header .actions .search` (new
CSS rule) `flex: 1 1 auto; min-width: 0` so it can shrink on narrow
viewports instead of forcing horizontal overflow. This requires changing
`.layout-header .actions` from `float: right` to a flex container
(`display: flex; align-items: center; gap: 16px`) so the search box can
actually participate in flex-shrink — floats don't shrink. The `.help`
and `.user` action items keep their current appearance, just via flex
instead of float+inline-padding.

## Non-goals (this phase)

- Table pages (horizontal scroll / column behavior) — Phase 2.
- Form pages (responsive `Col` spans) — Phase 3.
- Map component responsive sizing — Phase 4.
- Any change to what's *inside* the sidebar menu itself (`Menu.tsx`) or
  the tenant selector's own layout — only the Sider's collapse mechanics
  and the CSS margin compensating for it are in scope.

## Testing

Per project convention (`CLAUDE.md`), TDD applies where practically
possible. This repo has no frontend test framework at all yet — adding a
minimal one is in scope for this task rather than deferred:

- **New dev dependencies**: `vitest`, `@testing-library/react` (already a
  dependency per earlier `pnpm install` output this session —
  `@testing-library/jest-dom` was already present, `@testing-library/react`
  needs adding), `jsdom` (or Vitest's built-in `happy-dom` environment),
  `@vitejs/plugin-react` (Vitest reuses the existing Vite config).
- **New script** in `ui/package.json`: `"test": "vitest run"`.
- **What's actually unit-testable** (jsdom has no real CSS layout engine,
  so visual/responsive CSS behavior itself — the whole point of this
  phase — is NOT verifiable this way): the `collapsed` state wiring in
  `App.tsx` (does `onCollapse` update state; does the Sider receive the
  right `collapsedWidth`/`width` given that state) and the header search
  box's presence/props. These are logic/wiring tests, not visual tests —
  they catch regressions in the state plumbing, not "does it look right
  at 375px."
- **Manual verification remains required** for the actual visual
  responsive behavior: running `cd ui && pnpm start` and checking a few
  representative widths (375px phone, 768px tablet, 1024px+ desktop) via
  browser devtools' responsive mode — sidebar collapses/expands at the
  `lg` boundary, content reclaims the freed space, header search shrinks
  instead of overflowing, desktop appearance unchanged above `lg`. No
  amount of jsdom-based testing replaces this for a CSS-driven task.
- `cd ui && npx tsc -b --noEmit`, `cd ui && make build`, and `cd ui &&
  npx vitest run` must all stay clean.
