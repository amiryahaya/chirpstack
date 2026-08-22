# CLAUDE.md

Guidance for Claude Code working in this repo (a ChirpStack fork — Rust
backend in `chirpstack/`, React/TypeScript UI in `ui/`).

## TDD

Write the failing test first, run it to confirm it fails for the expected
reason, implement the minimal code to pass, run it again to confirm.

- **Backend (Rust):** the existing suite (`cd chirpstack && cargo test
  --features postgres`, or `make test` for the full fmt+clippy+test gate)
  is the pattern to follow — every new function or behavior change gets a
  test in the same file's `#[cfg(test)] mod test` block before the
  implementation.
- **Frontend (`ui/`):** no test framework is set up yet (no `test` script
  in `package.json`, no `*.test.ts(x)` files exist). TDD isn't practically
  applicable to frontend work until one is introduced (e.g. Vitest +
  React Testing Library) — treat this as a known gap, not something to
  silently work around. Flag it explicitly when a frontend task would
  benefit from tests, rather than skipping the conversation.

## SOLID

Applied pragmatically, not as OOP dogma forced onto Rust or React:

- **Single responsibility:** one Rust module/function or one React
  component/hook does one thing. If a file is accumulating unrelated
  concerns, that's a signal to split it — but don't split preemptively
  for hypothetical future needs.
- **Open/closed:** prefer extending via new trait impls, new match arms,
  or new components over editing a large existing function's internals
  when adding a variant — but don't add extension points (traits,
  plugin hooks) nobody has asked for yet.
- **Liskov substitution:** trait implementations and component prop
  contracts should behave consistently with what callers already assume
  (e.g. an `Integration` trait impl shouldn't silently change error
  semantics other impls don't have).
- **Interface segregation:** keep trait definitions and component prop
  interfaces narrow and focused on what the caller actually needs, not
  a wide catch-all.
- **Dependency inversion:** depend on the storage/integration trait
  boundaries this codebase already has (e.g. `Integration`,
  `storage::*` module functions) rather than reaching around them —
  but don't introduce a new abstraction layer just to satisfy this in
  the abstract; only where it aids real testability or already-planned
  swappability.

YAGNI still governs: apply these where the code is actually touched, not
as a excuse for speculative refactoring.
