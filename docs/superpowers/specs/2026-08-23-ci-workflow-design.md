# CI Workflow — Design Spec

Date: 2026-08-23
Status: Approved for implementation

## Summary

This fork has no CI at all (`.github/workflows/` does not exist). Add a
single GitHub Actions workflow that runs the backend and UI verification
this session already confirmed works, on every push and pull request
against `master`.

## Goals

- Run the existing `make test` target (cargo fmt check, clippy, full test
  suite) for both database backends the Makefile already supports.
- Build and type-check the UI.
- Use infrastructure this session has already verified working, rather
  than reinventing service setup.

## Non-goals (deferred)

- ESLint enforcement — the UI currently has 317 pre-existing lint errors
  unrelated to any single change; enforcing it now would make CI red on
  day one. Can be added later as a separate, non-blocking or gated step
  once the backlog is addressed.
- MQTT/Kafka/AMQP integration coverage (`test-all-integrations` feature) —
  `make test`'s default target does not require these services, and
  standing up mosquitto/kafka/rabbitmq in CI for a first workflow is
  disproportionate. Can be added as a separate job later if needed.
- Release/build/publish workflows (Docker images, packages, etc.) — out of
  scope, this is verification-only.

## Design

**File:** `.github/workflows/ci.yml`

**Triggers:** `push` and `pull_request`, both scoped to `branches: [master]`.

**Job `rust`:** matrix over `database: [postgres, sqlite]`.
- Starts `postgres` and `redis` via `docker compose up -d postgres redis`
  for BOTH matrix legs. Verified this session: `chirpstack/src/test/mod.rs`
  unconditionally reads `TEST_POSTGRESQL_DSN` and `TEST_REDIS_URL` into the
  test config regardless of which storage feature is compiled in (sqlite
  tests use `conf.sqlite.path = ":memory:"` and never actually open a
  postgres connection, but the env var must still be set or the `.unwrap()`
  panics) — so both containers are needed for either matrix leg, not just
  the postgres one.
- Installs `diesel_cli` (postgres+sqlite features) and runs
  `diesel migration run` against `migrations_postgres` before testing (the
  postgres schema must exist before `make test` runs; sqlite tests don't
  need a migrated file since they run in-memory and apply migrations at
  startup, per the `cargo test` runs observed all session).
- Runs `cd chirpstack && make test DATABASE=$MATRIX_VALUE`, which is
  exactly `cargo fmt --check && cargo clippy --no-deps --no-default-features
  --features="$DATABASE" && cargo test --no-default-features
  --features="$DATABASE"` per the existing `chirpstack/Makefile`.

**Job `ui`:** no matrix.
- Needs the grpc-web JS bindings generated before the UI can type-check
  (confirmed this session: without them, `tsc` fails with "Cannot find
  module '@chirpstack/chirpstack-api-grpc-web/...'"). Runs
  `cd api/grpc-web && make` (protoc + protoc-gen-grpc-web codegen) before
  `cd ui && make build` (`tsc -b && vite build`).
- Requires `protoc-gen-grpc-web` to be installed on the runner — GitHub's
  `ubuntu-latest` runners don't have it preinstalled, so the workflow
  installs it explicitly (matching how this session installed it locally
  via Homebrew, adapted to apt/binary-download for Linux CI runners).

## Testing

No local GitHub Actions runner (`act`) is available in this environment,
so this workflow cannot be fully dry-run before merging. It is built
directly from Makefile targets and service dependencies verified working
manually, end-to-end, throughout this session (`make test` passed 228/228
tests with exit 0; `cd ui && make build` succeeded after the grpc-web
toolchain was fixed). First real confirmation will be the initial run
after this is pushed — flag any failure there as a workflow-tuning issue,
not necessarily a code regression.
