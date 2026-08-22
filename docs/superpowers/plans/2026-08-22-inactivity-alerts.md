# Inactivity Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email a tenant's configured recipients when a gateway or device transitions between active and inactive, using per-tenant SMTP settings and a per-entity enable/disable toggle.

**Architecture:** A new background "reaper" loop (mirroring the existing downlink scheduler pattern) periodically queries gateways/devices whose alerting is enabled, reuses each entity type's existing inactivity-threshold convention, detects state transitions against a persisted `alert_state` column, and sends email via a new per-tenant SMTP client (the first email-sending capability in ChirpStack). New proto fields on `Tenant`/`Gateway`/`Device` plus one new RPC (`TestAlertEmail`) expose this to the API and UI.

**Tech Stack:** Rust (Diesel ORM, tokio, tonic gRPC), `lettre` (new dependency) for SMTP, Protocol Buffers, React/TypeScript + antd (UI), grpc-web.

**Spec:** `docs/superpowers/specs/2026-08-22-inactivity-alerts-design.md`

## Global Constraints

- Device inactivity threshold is `device_profile.uplink_interval * 1.5` seconds — this is the codebase's existing convention (`device::get_active_inactive()`), not a new invention. Devices with `uplink_interval == 0` are skipped entirely.
- Gateway inactivity threshold is `stats_interval_secs * 2` seconds — the codebase's existing convention (`gateway::get_counts_by_state()`).
- Never-seen entities (`last_seen_at IS NULL`) are skipped entirely — no alerting without a baseline.
- SMTP credentials are stored as plaintext in Postgres/SQLite, matching the existing convention for all other integration credentials in this codebase (e.g. `AwsSnsConfiguration.secret_access_key`). This is a known pre-existing limitation, not new scope.
- `alert_enabled` proto fields are `optional bool` (proto3 explicit presence), matching this fork's existing convention for resolving default-value ambiguity (see the `GatewayState` filter's use of `optional` in `ListGatewaysRequest`). This lets the backend apply "default true" only when a client omits the field, while the UI always sets it explicitly.
- Reuse `fields::StringVec` (`chirpstack/chirpstack/src/storage/fields/string_vec.rs`) for the email address list — do not invent a new custom Diesel type.
- New dependency: `lettre = "0.11"` with `tokio1-rustls-tls`, `smtp-transport`, `builder` features, matching the project's existing rustls-only TLS convention (see `reqwest` in the workspace `Cargo.toml`).
- All new background-loop code follows the existing scheduler pattern exactly: `loop { work().await; sleep(interval).await }`, `trace!`/`error!` logging via `tracing`, config pulled once via `config::get()`.
- Every `diesel::sql_query` that does backend-specific date arithmetic must have both a `#[cfg(feature = "postgres")]` and `#[cfg(feature = "sqlite")]` implementation, matching `gateway::get_counts_by_state()` / `device::get_active_inactive()`.

---

## Task 1: Tenant SMTP + alert email storage

**Files:**
- Create: `chirpstack/chirpstack/migrations_postgres/<generated>_add_tenant_alert_config/up.sql`
- Create: `chirpstack/chirpstack/migrations_postgres/<generated>_add_tenant_alert_config/down.sql`
- Create: `chirpstack/chirpstack/migrations_sqlite/<generated>_add_tenant_alert_config/up.sql`
- Create: `chirpstack/chirpstack/migrations_sqlite/<generated>_add_tenant_alert_config/down.sql`
- Modify: `chirpstack/chirpstack/src/storage/tenant.rs`
- Modify (auto-generated, do not hand-edit beyond running the make target): `chirpstack/chirpstack/src/storage/schema_postgres.rs`, `chirpstack/chirpstack/src/storage/schema_sqlite.rs`
- Test: `chirpstack/chirpstack/src/storage/tenant.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Produces: `Tenant` struct gains `alert_smtp_host: String`, `alert_smtp_port: i32`, `alert_smtp_username: String`, `alert_smtp_password: String`, `alert_smtp_from_email: String`, `alert_smtp_use_tls: bool`, `alert_email_addresses: fields::StringVec`. `tenant::create()`/`tenant::get()`/`tenant::update()` persist all of these.

- [ ] **Step 1: Write the failing test**

Add to the existing `pub mod test` block in `chirpstack/chirpstack/src/storage/tenant.rs` (follow the exact create/get/update/assert_eq shape already used by the other tests in that module):

```rust
#[tokio::test]
async fn test_alert_config() {
    let _guard = test::prepare().await;

    let mut t = Tenant {
        name: "alert-tenant".into(),
        alert_smtp_host: "smtp.example.com".into(),
        alert_smtp_port: 587,
        alert_smtp_username: "smtp-user".into(),
        alert_smtp_password: "smtp-pass".into(),
        alert_smtp_from_email: "alerts@example.com".into(),
        alert_smtp_use_tls: true,
        alert_email_addresses: fields::StringVec::new(vec![
            Some("ops@example.com".into()),
            Some("oncall@example.com".into()),
        ]),
        ..Default::default()
    };
    t = create(t).await.unwrap();

    let t_get = get(&t.id).await.unwrap();
    assert_eq!(t, t_get);

    t.alert_smtp_host = "smtp2.example.com".into();
    t.alert_smtp_use_tls = false;
    t.alert_email_addresses = fields::StringVec::new(vec![Some("new@example.com".into())]);
    t = update(t).await.unwrap();

    let t_get = get(&t.id).await.unwrap();
    assert_eq!(t, t_get);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::tenant::test::test_alert_config -- --nocapture`
Expected: FAIL to compile — `Tenant` has no field `alert_smtp_host` (etc.), and no such column exists yet.

- [ ] **Step 3: Write the migrations**

Run `cd chirpstack/chirpstack && diesel --config-file diesel_postgres.toml migration --migration-dir migrations_postgres generate add_tenant_alert_config` and `diesel --config-file diesel_sqlite.toml migration --migration-dir migrations_sqlite generate add_tenant_alert_config` to create the timestamped folders, then fill in:

`migrations_postgres/<ts>_add_tenant_alert_config/up.sql`:
```sql
alter table tenant add column alert_smtp_host text not null default '';
alter table tenant add column alert_smtp_port integer not null default 587;
alter table tenant add column alert_smtp_username text not null default '';
alter table tenant add column alert_smtp_password text not null default '';
alter table tenant add column alert_smtp_from_email text not null default '';
alter table tenant add column alert_smtp_use_tls boolean not null default true;
alter table tenant add column alert_email_addresses text[] not null default '{}';
```

`migrations_postgres/<ts>_add_tenant_alert_config/down.sql`:
```sql
alter table tenant drop column alert_smtp_host;
alter table tenant drop column alert_smtp_port;
alter table tenant drop column alert_smtp_username;
alter table tenant drop column alert_smtp_password;
alter table tenant drop column alert_smtp_from_email;
alter table tenant drop column alert_smtp_use_tls;
alter table tenant drop column alert_email_addresses;
```

`migrations_sqlite/<ts>_add_tenant_alert_config/up.sql`:
```sql
alter table tenant add column alert_smtp_host text not null default '';
alter table tenant add column alert_smtp_port integer not null default 587;
alter table tenant add column alert_smtp_username text not null default '';
alter table tenant add column alert_smtp_password text not null default '';
alter table tenant add column alert_smtp_from_email text not null default '';
alter table tenant add column alert_smtp_use_tls boolean not null default true;
alter table tenant add column alert_email_addresses text not null default '[]';
```

`migrations_sqlite/<ts>_add_tenant_alert_config/down.sql`: identical `drop column` statements to the Postgres `down.sql`.

Then regenerate the Diesel schema for both backends:
```bash
cd chirpstack/chirpstack
make migration-run DATABASE=postgres
make migration-run DATABASE=sqlite
```
Verify `src/storage/schema_postgres.rs`'s `tenant` table block now ends with:
```rust
alert_smtp_host -> Text,
alert_smtp_port -> Int4,
alert_smtp_username -> Text,
alert_smtp_password -> Text,
alert_smtp_from_email -> Text,
alert_smtp_use_tls -> Bool,
alert_email_addresses -> Array<Nullable<Text>>,
```
and `schema_sqlite.rs`'s `tenant` block ends with the same column names typed `Text`/`Integer`/`Bool`/`Text`.

- [ ] **Step 4: Update the `Tenant` struct and CRUD functions**

In `chirpstack/chirpstack/src/storage/tenant.rs`, append to the `Tenant` struct (order must match the migration's column-append order):

```rust
pub alert_smtp_host: String,
pub alert_smtp_port: i32,
pub alert_smtp_username: String,
pub alert_smtp_password: String,
pub alert_smtp_from_email: String,
pub alert_smtp_use_tls: bool,
pub alert_email_addresses: fields::StringVec,
```

If `tenant.rs` has a manual `impl Default for Tenant` block, add matching defaults there:
```rust
alert_smtp_host: String::new(),
alert_smtp_port: 587,
alert_smtp_username: String::new(),
alert_smtp_password: String::new(),
alert_smtp_from_email: String::new(),
alert_smtp_use_tls: true,
alert_email_addresses: fields::StringVec::default(),
```

In the `update()` function, add to the `.set((...))` tuple:
```rust
tenant::alert_smtp_host.eq(&t.alert_smtp_host),
tenant::alert_smtp_port.eq(&t.alert_smtp_port),
tenant::alert_smtp_username.eq(&t.alert_smtp_username),
tenant::alert_smtp_password.eq(&t.alert_smtp_password),
tenant::alert_smtp_from_email.eq(&t.alert_smtp_from_email),
tenant::alert_smtp_use_tls.eq(&t.alert_smtp_use_tls),
tenant::alert_email_addresses.eq(&t.alert_email_addresses),
```
`create()` needs no change — `diesel::insert_into(tenant::table).values(&t)` already inserts every struct field.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::tenant::test::test_alert_config -- --nocapture`
Expected: PASS

Also run with `--features sqlite` if the project's test setup supports switching backends locally (check `chirpstack/chirpstack/Makefile`'s `test` target for how CI runs both).

- [ ] **Step 6: Commit**

```bash
git add chirpstack/chirpstack/migrations_postgres chirpstack/chirpstack/migrations_sqlite chirpstack/chirpstack/src/storage/tenant.rs chirpstack/chirpstack/src/storage/schema_postgres.rs chirpstack/chirpstack/src/storage/schema_sqlite.rs
git commit -m "feat: add tenant alert SMTP config and email address list"
```

---

## Task 2: Gateway alert-enabled + alert-state storage

**Files:**
- Create: `chirpstack/chirpstack/migrations_postgres/<generated>_add_gateway_alert_state/up.sql` + `down.sql`
- Create: `chirpstack/chirpstack/migrations_sqlite/<generated>_add_gateway_alert_state/up.sql` + `down.sql`
- Modify: `chirpstack/chirpstack/src/storage/gateway.rs`
- Test: `chirpstack/chirpstack/src/storage/gateway.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `Gateway` struct gains `alert_enabled: bool`, `alert_state: i16`. New functions: `gateway::set_alert_enabled(gateway_id: &EUI64, enabled: bool) -> Result<(), Error>` (atomically resets `alert_state` to `0` only on a `false -> true` transition) and `gateway::set_alert_state(gateway_id: &EUI64, state: i16) -> Result<(), Error>`.

- [ ] **Step 1: Write the failing test**

Add to `gateway.rs`'s test module:

```rust
#[tokio::test]
async fn test_alert_enabled_and_state() {
    let _guard = test::prepare().await;
    let t = storage::tenant::test::create_tenant().await;

    let mut gw = Gateway {
        gateway_id: EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
        tenant_id: t.id,
        name: "test-gw".into(),
        alert_enabled: true,
        alert_state: 0,
        ..Default::default()
    };
    gw = create(gw).await.unwrap();
    assert_eq!(0, gw.alert_state);

    set_alert_state(&gw.gateway_id, 2).await.unwrap();
    let gw_get = get(&gw.gateway_id).await.unwrap();
    assert_eq!(2, gw_get.alert_state);

    // Disabling must not reset alert_state.
    set_alert_enabled(&gw.gateway_id, false).await.unwrap();
    let gw_get = get(&gw.gateway_id).await.unwrap();
    assert!(!gw_get.alert_enabled);
    assert_eq!(2, gw_get.alert_state);

    // Re-enabling must reset alert_state to 0 (unknown).
    set_alert_enabled(&gw.gateway_id, true).await.unwrap();
    let gw_get = get(&gw.gateway_id).await.unwrap();
    assert!(gw_get.alert_enabled);
    assert_eq!(0, gw_get.alert_state);
}
```

This uses `storage::tenant::test::create_tenant() -> Tenant`, the shared fixture helper already used by `gateway.rs`'s own existing tests (e.g. its `create_gateway()` test helper at `gateway.rs:594-608`), and `EUI64::from_be_bytes([...])`, the construction style used throughout this file's existing tests (e.g. `test_gateway`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::gateway::test::test_alert_enabled_and_state -- --nocapture`
Expected: FAIL to compile — no `alert_enabled`/`alert_state` fields or functions exist yet.

- [ ] **Step 3: Write the migrations**

`migrations_postgres/<ts>_add_gateway_alert_state/up.sql`:
```sql
alter table gateway add column alert_enabled boolean not null default true;
alter table gateway add column alert_state smallint not null default 0;
```
`down.sql`:
```sql
alter table gateway drop column alert_enabled;
alter table gateway drop column alert_state;
```
`migrations_sqlite/<ts>_add_gateway_alert_state/up.sql` / `down.sql`: identical SQL (SQLite accepts `boolean`/`smallint` as type affinities, matching the codebase's existing convention).

Run `make migration-run DATABASE=postgres` and `make migration-run DATABASE=sqlite` from `chirpstack/chirpstack`, and verify the `gateway` table block in both schema files gains `alert_enabled -> Bool,` and `alert_state -> Int2,`.

- [ ] **Step 4: Update the `Gateway` struct and add the two new functions**

Append to the `Gateway` struct:
```rust
pub alert_enabled: bool,
pub alert_state: i16,
```

Do **not** add these to the existing `update()` function's `.set(...)` — they are managed exclusively by the two new functions below, so a routine "save the gateway form" call never silently touches alert state.

Add near the other `pub async fn` in `gateway.rs`:
```rust
#[cfg(feature = "postgres")]
pub async fn set_alert_enabled(gateway_id: &EUI64, enabled: bool) -> Result<(), Error> {
    diesel::sql_query(
        r#"
        update gateway
        set
            alert_enabled = $2,
            alert_state = case when alert_enabled = false and $2 = true then 0 else alert_state end
        where gateway_id = $1
        "#,
    )
    .bind::<diesel::sql_types::Binary, _>(gateway_id)
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .execute(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, gateway_id.to_string()))?;
    Ok(())
}

#[cfg(feature = "sqlite")]
pub async fn set_alert_enabled(gateway_id: &EUI64, enabled: bool) -> Result<(), Error> {
    diesel::sql_query(
        r#"
        update gateway
        set
            alert_enabled = ?,
            alert_state = case when alert_enabled = 0 and ? = 1 then 0 else alert_state end
        where gateway_id = ?
        "#,
    )
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .bind::<diesel::sql_types::Binary, _>(gateway_id)
    .execute(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, gateway_id.to_string()))?;
    Ok(())
}

pub async fn set_alert_state(gateway_id: &EUI64, state: i16) -> Result<(), Error> {
    diesel::update(gateway::dsl::gateway.find(gateway_id))
        .set(gateway::alert_state.eq(state))
        .execute(&mut get_async_db_conn().await?)
        .await
        .map_err(|e| Error::from_diesel(e, gateway_id.to_string()))?;
    Ok(())
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::gateway::test::test_alert_enabled_and_state -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add chirpstack/chirpstack/migrations_postgres chirpstack/chirpstack/migrations_sqlite chirpstack/chirpstack/src/storage/gateway.rs chirpstack/chirpstack/src/storage/schema_postgres.rs chirpstack/chirpstack/src/storage/schema_sqlite.rs
git commit -m "feat: add gateway alert_enabled and alert_state columns"
```

---

## Task 3: Device alert-enabled + alert-state storage

**Files:**
- Create: `chirpstack/chirpstack/migrations_postgres/<generated>_add_device_alert_state/up.sql` + `down.sql`
- Create: `chirpstack/chirpstack/migrations_sqlite/<generated>_add_device_alert_state/up.sql` + `down.sql`
- Modify: `chirpstack/chirpstack/src/storage/device.rs`
- Test: `chirpstack/chirpstack/src/storage/device.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Produces: `Device` struct gains `alert_enabled: bool`, `alert_state: i16`. New functions: `device::set_alert_enabled(dev_eui: &EUI64, enabled: bool) -> Result<(), Error>` (same reset-on-enable semantics as Task 2) and `device::set_alert_state(dev_eui: &EUI64, state: i16) -> Result<(), Error>`.

This task is structurally identical to Task 2, applied to `device`/`dev_eui` instead of `gateway`/`gateway_id`.

- [ ] **Step 1: Write the failing test**

Device fixtures need a `device_profile` and `application` before a `device` can be created. `device.rs`'s existing `create_device()` test helper (`device.rs:1124-1150`) builds this chain but always uses `..Default::default()` for `alert_enabled`/`alert_state`, so this test builds the `Device` directly (mirroring what `create_device()` does internally) to set `alert_enabled: true` explicitly at creation:

```rust
#[tokio::test]
async fn test_alert_enabled_and_state() {
    let _guard = test::prepare().await;
    let dp = storage::device_profile::test::create_device_profile(None).await;
    let tenant_id = dp.tenant_id.unwrap();
    let app = storage::application::test::create_application(Some(tenant_id.into())).await;

    let mut d = Device {
        name: "test-dev".into(),
        dev_eui: EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
        application_id: app.id,
        device_profile_id: dp.id.into(),
        alert_enabled: true,
        alert_state: 0,
        ..Default::default()
    };
    d = create(d).await.unwrap();
    assert_eq!(0, d.alert_state);

    set_alert_state(&d.dev_eui, 2).await.unwrap();
    let d_get = get(&d.dev_eui).await.unwrap();
    assert_eq!(2, d_get.alert_state);

    // Disabling must not reset alert_state.
    set_alert_enabled(&d.dev_eui, false).await.unwrap();
    let d_get = get(&d.dev_eui).await.unwrap();
    assert!(!d_get.alert_enabled);
    assert_eq!(2, d_get.alert_state);

    // Re-enabling must reset alert_state to 0 (unknown).
    set_alert_enabled(&d.dev_eui, true).await.unwrap();
    let d_get = get(&d.dev_eui).await.unwrap();
    assert!(d_get.alert_enabled);
    assert_eq!(0, d_get.alert_state);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::device::test::test_alert_enabled_and_state -- --nocapture`
Expected: FAIL to compile.

- [ ] **Step 3: Write the migrations**

`migrations_postgres/<ts>_add_device_alert_state/up.sql`:
```sql
alter table device add column alert_enabled boolean not null default true;
alter table device add column alert_state smallint not null default 0;
```
`down.sql`:
```sql
alter table device drop column alert_enabled;
alter table device drop column alert_state;
```
`migrations_sqlite` versions: identical SQL.

Run `make migration-run DATABASE=postgres` and `make migration-run DATABASE=sqlite`; verify both schema files' `device` table block gains `alert_enabled -> Bool,` and `alert_state -> Int2,`.

- [ ] **Step 4: Update the `Device` struct and add the two new functions**

Append to `Device`:
```rust
pub alert_enabled: bool,
pub alert_state: i16,
```

Do not add these to the existing `update()`. Add (same shape as Task 2, `device`/`dev_eui` instead of `gateway`/`gateway_id`):
```rust
#[cfg(feature = "postgres")]
pub async fn set_alert_enabled(dev_eui: &EUI64, enabled: bool) -> Result<(), Error> {
    diesel::sql_query(
        r#"
        update device
        set
            alert_enabled = $2,
            alert_state = case when alert_enabled = false and $2 = true then 0 else alert_state end
        where dev_eui = $1
        "#,
    )
    .bind::<diesel::sql_types::Binary, _>(dev_eui)
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .execute(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, dev_eui.to_string()))?;
    Ok(())
}

#[cfg(feature = "sqlite")]
pub async fn set_alert_enabled(dev_eui: &EUI64, enabled: bool) -> Result<(), Error> {
    diesel::sql_query(
        r#"
        update device
        set
            alert_enabled = ?,
            alert_state = case when alert_enabled = 0 and ? = 1 then 0 else alert_state end
        where dev_eui = ?
        "#,
    )
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .bind::<diesel::sql_types::Bool, _>(enabled)
    .bind::<diesel::sql_types::Binary, _>(dev_eui)
    .execute(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, dev_eui.to_string()))?;
    Ok(())
}

pub async fn set_alert_state(dev_eui: &EUI64, state: i16) -> Result<(), Error> {
    diesel::update(device::dsl::device.find(dev_eui))
        .set(device::alert_state.eq(state))
        .execute(&mut get_async_db_conn().await?)
        .await
        .map_err(|e| Error::from_diesel(e, dev_eui.to_string()))?;
    Ok(())
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::device::test::test_alert_enabled_and_state -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add chirpstack/chirpstack/migrations_postgres chirpstack/chirpstack/migrations_sqlite chirpstack/chirpstack/src/storage/device.rs chirpstack/chirpstack/src/storage/schema_postgres.rs chirpstack/chirpstack/src/storage/schema_sqlite.rs
git commit -m "feat: add device alert_enabled and alert_state columns"
```

---

## Task 4: Alert event audit log storage

**Files:**
- Create: `chirpstack/chirpstack/migrations_postgres/<generated>_create_alert_event/up.sql` + `down.sql`
- Create: `chirpstack/chirpstack/migrations_sqlite/<generated>_create_alert_event/up.sql` + `down.sql`
- Create: `chirpstack/chirpstack/src/storage/alert_event.rs`
- Modify: `chirpstack/chirpstack/src/storage/mod.rs` (register the new module — follow how `tenant`/`gateway`/`device` are declared there)
- Test: `chirpstack/chirpstack/src/storage/alert_event.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Consumes: `fields::Uuid` (existing), `lrwn::EUI64` (existing).
- Produces: `alert_event::AlertEvent` struct, `alert_event::insert(ae: AlertEvent) -> Result<AlertEvent, Error>`.

- [ ] **Step 1: Write the failing test**

Create `chirpstack/chirpstack/src/storage/alert_event.rs` with:

```rust
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use lrwn::EUI64;
use uuid::Uuid;

use super::error::Error;
use super::schema::alert_event;
use super::{fields, get_async_db_conn};

#[derive(Queryable, Insertable, PartialEq, Eq, Debug, Clone)]
#[diesel(table_name = alert_event)]
pub struct AlertEvent {
    pub id: fields::Uuid,
    pub entity_type: i16,
    pub entity_id: EUI64,
    pub tenant_id: fields::Uuid,
    pub previous_state: i16,
    pub new_state: i16,
    pub created_at: DateTime<Utc>,
    pub email_sent: bool,
}

pub const ENTITY_TYPE_GATEWAY: i16 = 0;
pub const ENTITY_TYPE_DEVICE: i16 = 1;

pub async fn insert(ae: AlertEvent) -> Result<AlertEvent, Error> {
    diesel::insert_into(alert_event::table)
        .values(&ae)
        .get_result(&mut get_async_db_conn().await?)
        .await
        .map_err(|e| Error::from_diesel(e, ae.id.to_string()))
}

#[cfg(test)]
pub mod test {
    use super::*;

    #[tokio::test]
    async fn test_insert() {
        let _guard = crate::storage::test::prepare().await;

        let ae = AlertEvent {
            id: fields::Uuid::from(Uuid::new_v4()),
            entity_type: ENTITY_TYPE_GATEWAY,
            entity_id: EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
            tenant_id: fields::Uuid::from(Uuid::new_v4()),
            previous_state: 1,
            new_state: 2,
            created_at: Utc::now(),
            email_sent: true,
        };
        let inserted = insert(ae.clone()).await.unwrap();
        assert_eq!(ae.id, inserted.id);
        assert_eq!(ae.entity_type, inserted.entity_type);
        assert_eq!(ae.new_state, inserted.new_state);
    }
}
```

(Match the exact `use` paths of `error::Error`, `fields`, `get_async_db_conn` to whatever `gateway.rs`/`device.rs` already import — copy their import block rather than guessing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::alert_event::test::test_insert -- --nocapture`
Expected: FAIL — module not registered in `storage/mod.rs`, table doesn't exist yet.

- [ ] **Step 3: Register the module**

In `chirpstack/chirpstack/src/storage/mod.rs`, add `pub mod alert_event;` alongside the existing `pub mod tenant;`, `pub mod gateway;`, `pub mod device;` declarations.

- [ ] **Step 4: Write the migrations**

`migrations_postgres/<ts>_create_alert_event/up.sql`:
```sql
create table alert_event (
    id uuid primary key,
    entity_type smallint not null,
    entity_id bytea not null,
    tenant_id uuid not null references tenant on delete cascade,
    previous_state smallint not null,
    new_state smallint not null,
    created_at timestamp with time zone not null,
    email_sent boolean not null
);

create index idx_alert_event_tenant_id on alert_event (tenant_id);
create index idx_alert_event_entity_id on alert_event (entity_id);
```
`down.sql`:
```sql
drop table alert_event;
```

`migrations_sqlite/<ts>_create_alert_event/up.sql`:
```sql
create table alert_event (
    id text primary key,
    entity_type smallint not null,
    entity_id blob not null,
    tenant_id text not null references tenant on delete cascade,
    previous_state smallint not null,
    new_state smallint not null,
    created_at datetime not null,
    email_sent boolean not null
);

create index idx_alert_event_tenant_id on alert_event (tenant_id);
create index idx_alert_event_entity_id on alert_event (entity_id);
```
`down.sql`: `drop table alert_event;`

Run `make migration-run DATABASE=postgres` and `make migration-run DATABASE=sqlite`; verify `schema_postgres.rs`/`schema_sqlite.rs` gained an `alert_event` `table!` block with the 8 columns above.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::alert_event::test::test_insert -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add chirpstack/chirpstack/migrations_postgres chirpstack/chirpstack/migrations_sqlite chirpstack/chirpstack/src/storage/alert_event.rs chirpstack/chirpstack/src/storage/mod.rs chirpstack/chirpstack/src/storage/schema_postgres.rs chirpstack/chirpstack/src/storage/schema_sqlite.rs
git commit -m "feat: add alert_event audit log table"
```

---

## Task 5: Alert state transition logic (pure)

**Files:**
- Create: `chirpstack/chirpstack/src/alert/mod.rs`
- Create: `chirpstack/chirpstack/src/alert/state.rs`
- Modify: `chirpstack/chirpstack/src/lib.rs` (register `pub mod alert;` — check exactly how `pub mod downlink;` is declared there and copy the pattern)
- Test: `chirpstack/chirpstack/src/alert/state.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Produces: `alert::state::AlertState` enum (`Unknown`/`Active`/`Inactive`, with `from_i16`/`to_i16`), `alert::state::Transition` enum (`None`/`RecordOnly`/`WentInactive`/`Recovered`), `alert::state::evaluate(previous: AlertState, is_inactive: bool) -> (AlertState, Transition)`.

- [ ] **Step 1: Write the failing test**

Create `chirpstack/chirpstack/src/alert/state.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertState {
    Unknown,
    Active,
    Inactive,
}

impl AlertState {
    pub fn from_i16(v: i16) -> Self {
        match v {
            1 => AlertState::Active,
            2 => AlertState::Inactive,
            _ => AlertState::Unknown,
        }
    }

    pub fn to_i16(self) -> i16 {
        match self {
            AlertState::Unknown => 0,
            AlertState::Active => 1,
            AlertState::Inactive => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    None,
    RecordOnly,
    WentInactive,
    Recovered,
}

pub fn evaluate(previous: AlertState, is_inactive: bool) -> (AlertState, Transition) {
    let new_state = if is_inactive {
        AlertState::Inactive
    } else {
        AlertState::Active
    };

    let transition = match (previous, new_state) {
        (AlertState::Unknown, _) => Transition::RecordOnly,
        (AlertState::Active, AlertState::Inactive) => Transition::WentInactive,
        (AlertState::Inactive, AlertState::Active) => Transition::Recovered,
        _ => Transition::None,
    };

    (new_state, transition)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_evaluate() {
        assert_eq!(
            (AlertState::Active, Transition::RecordOnly),
            evaluate(AlertState::Unknown, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::RecordOnly),
            evaluate(AlertState::Unknown, true)
        );
        assert_eq!(
            (AlertState::Active, Transition::None),
            evaluate(AlertState::Active, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::WentInactive),
            evaluate(AlertState::Active, true)
        );
        assert_eq!(
            (AlertState::Active, Transition::Recovered),
            evaluate(AlertState::Inactive, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::None),
            evaluate(AlertState::Inactive, true)
        );
    }

    #[test]
    fn test_state_i16_roundtrip() {
        for s in [AlertState::Unknown, AlertState::Active, AlertState::Inactive] {
            assert_eq!(s, AlertState::from_i16(s.to_i16()));
        }
    }
}
```

Create `chirpstack/chirpstack/src/alert/mod.rs` with just:
```rust
pub mod state;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test alert::state::test -- --nocapture`
Expected: FAIL to compile — `alert` module not registered in `lib.rs` yet.

- [ ] **Step 3: Register the module**

In `chirpstack/chirpstack/src/lib.rs`, add `pub mod alert;` next to the existing `pub mod downlink;` (or wherever the top-level module list lives — match its exact ordering/style).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test alert::state::test -- --nocapture`
Expected: PASS (both `test_evaluate` and `test_state_i16_roundtrip`)

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/alert chirpstack/chirpstack/src/lib.rs
git commit -m "feat: add pure alert state transition logic"
```

---

## Task 6: Gateway alert candidate query

**Files:**
- Modify: `chirpstack/chirpstack/src/storage/gateway.rs`
- Test: `chirpstack/chirpstack/src/storage/gateway.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Consumes: Task 2's `Gateway.alert_enabled`/`alert_state` columns.
- Produces: `gateway::GatewayAlertCandidate { gateway_id: EUI64, tenant_id: fields::Uuid, name: String, alert_state: i16, is_inactive: bool }`, `gateway::get_alert_candidates() -> Result<Vec<GatewayAlertCandidate>, Error>`.

- [ ] **Step 1: Write the failing test**

Add to `gateway.rs`'s test module. `gateway.rs` has no existing precedent for backdating `last_seen_at` (confirmed: `get_counts_by_state()` has no test coverage in this file), so this test sets it directly in the struct literal passed to `create()` — `create()` inserts exactly what the struct holds, no server-side override:

```rust
#[tokio::test]
async fn test_get_alert_candidates() {
    let _guard = test::prepare().await;
    let t = storage::tenant::test::create_tenant().await;

    // A gateway that has never sent stats: last_seen_at is None, must not appear.
    let never_seen = create(Gateway {
        gateway_id: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 1]),
        tenant_id: t.id,
        name: "never-seen".into(),
        alert_enabled: true,
        stats_interval_secs: 30,
        ..Default::default()
    }).await.unwrap();

    // A gateway with alerting disabled, last seen long ago: must not appear.
    let disabled = create(Gateway {
        gateway_id: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 2]),
        tenant_id: t.id,
        name: "disabled".into(),
        alert_enabled: false,
        stats_interval_secs: 30,
        last_seen_at: Some(Utc::now() - chrono::Duration::seconds(600)),
        ..Default::default()
    }).await.unwrap();

    // A gateway that is alert-enabled and stale: must appear with is_inactive = true.
    let stale = create(Gateway {
        gateway_id: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 3]),
        tenant_id: t.id,
        name: "stale".into(),
        alert_enabled: true,
        stats_interval_secs: 30,
        last_seen_at: Some(Utc::now() - chrono::Duration::seconds(600)),
        ..Default::default()
    }).await.unwrap();

    let candidates = get_alert_candidates().await.unwrap();
    let ids: Vec<EUI64> = candidates.iter().map(|c| c.gateway_id).collect();
    assert!(!ids.contains(&never_seen.gateway_id));
    assert!(!ids.contains(&disabled.gateway_id));
    assert!(ids.contains(&stale.gateway_id));

    let stale_candidate = candidates.iter().find(|c| c.gateway_id == stale.gateway_id).unwrap();
    assert!(stale_candidate.is_inactive);
    assert_eq!(0, stale_candidate.alert_state);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::gateway::test::test_get_alert_candidates -- --nocapture`
Expected: FAIL to compile — no such struct/function.

- [ ] **Step 3: Implement the query**

Add to `gateway.rs`:

```rust
#[derive(QueryableByName, Debug, Clone)]
pub struct GatewayAlertCandidate {
    #[diesel(sql_type = diesel::sql_types::Binary)]
    pub gateway_id: EUI64,
    #[diesel(sql_type = fields::sql_types::Uuid)]
    pub tenant_id: fields::Uuid,
    #[diesel(sql_type = diesel::sql_types::Text)]
    pub name: String,
    #[diesel(sql_type = diesel::sql_types::SmallInt)]
    pub alert_state: i16,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    pub is_inactive: bool,
}

#[cfg(feature = "postgres")]
pub async fn get_alert_candidates() -> Result<Vec<GatewayAlertCandidate>, Error> {
    diesel::sql_query(
        r#"
        select
            gateway_id,
            tenant_id,
            name,
            alert_state,
            (now() - last_seen_at) > make_interval(secs => stats_interval_secs * 2) as is_inactive
        from gateway
        where alert_enabled = true and last_seen_at is not null
        "#,
    )
    .load(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, "".into()))
}

#[cfg(feature = "sqlite")]
pub async fn get_alert_candidates() -> Result<Vec<GatewayAlertCandidate>, Error> {
    diesel::sql_query(
        r#"
        select
            gateway_id,
            tenant_id,
            name,
            alert_state,
            (unixepoch('now') - unixepoch(last_seen_at)) > (stats_interval_secs * 2) as is_inactive
        from gateway
        where alert_enabled = 1 and last_seen_at is not null
        "#,
    )
    .load(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, "".into()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::gateway::test::test_get_alert_candidates -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/storage/gateway.rs
git commit -m "feat: add gateway alert candidate query"
```

---

## Task 7: Device alert candidate query

**Files:**
- Modify: `chirpstack/chirpstack/src/storage/device.rs`
- Test: `chirpstack/chirpstack/src/storage/device.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Consumes: Task 3's `Device.alert_enabled`/`alert_state` columns.
- Produces: `device::DeviceAlertCandidate { dev_eui: EUI64, tenant_id: fields::Uuid, name: String, alert_state: i16, is_inactive: bool }`, `device::get_alert_candidates() -> Result<Vec<DeviceAlertCandidate>, Error>`.

- [ ] **Step 1: Write the failing test**

Add to `device.rs`'s test module. `storage::device_profile::test::create_device_profile(None)` creates a profile with `uplink_interval = 60` by default (its test-factory default); for the zero-interval case, create one the same way then overwrite `uplink_interval` via `device_profile::update()`:

```rust
#[tokio::test]
async fn test_get_alert_candidates() {
    let _guard = test::prepare().await;
    let dp = storage::device_profile::test::create_device_profile(None).await;
    let tenant_id = dp.tenant_id.unwrap();

    let mut dp_zero = storage::device_profile::test::create_device_profile(None).await;
    dp_zero.uplink_interval = 0;
    dp_zero = storage::device_profile::update(dp_zero).await.unwrap();

    let app = storage::application::test::create_application(Some(tenant_id.into())).await;

    // Never sent an uplink: last_seen_at is None, must not appear.
    let never_seen = create(Device {
        name: "never-seen".into(),
        dev_eui: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 1]),
        application_id: app.id,
        device_profile_id: dp.id.into(),
        alert_enabled: true,
        ..Default::default()
    }).await.unwrap();

    // Alerting disabled, stale: must not appear.
    let disabled = create(Device {
        name: "disabled".into(),
        dev_eui: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 2]),
        application_id: app.id,
        device_profile_id: dp.id.into(),
        alert_enabled: false,
        last_seen_at: Some(Utc::now() - chrono::Duration::seconds(600)),
        ..Default::default()
    }).await.unwrap();

    // uplink_interval = 0 ("not configured"), stale: must not appear.
    let zero_interval = create(Device {
        name: "zero-interval".into(),
        dev_eui: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 3]),
        application_id: app.id,
        device_profile_id: dp_zero.id.into(),
        alert_enabled: true,
        last_seen_at: Some(Utc::now() - chrono::Duration::seconds(600)),
        ..Default::default()
    }).await.unwrap();

    // Alert-enabled, past 60 * 1.5 = 90 seconds since last seen: must appear, is_inactive = true.
    let stale = create(Device {
        name: "stale".into(),
        dev_eui: EUI64::from_be_bytes([0, 0, 0, 0, 0, 0, 0, 4]),
        application_id: app.id,
        device_profile_id: dp.id.into(),
        alert_enabled: true,
        last_seen_at: Some(Utc::now() - chrono::Duration::seconds(600)),
        ..Default::default()
    }).await.unwrap();

    let candidates = get_alert_candidates().await.unwrap();
    let ids: Vec<EUI64> = candidates.iter().map(|c| c.dev_eui).collect();
    assert!(!ids.contains(&never_seen.dev_eui));
    assert!(!ids.contains(&disabled.dev_eui));
    assert!(!ids.contains(&zero_interval.dev_eui));
    assert!(ids.contains(&stale.dev_eui));

    let stale_candidate = candidates.iter().find(|c| c.dev_eui == stale.dev_eui).unwrap();
    assert!(stale_candidate.is_inactive);
    assert_eq!(0, stale_candidate.alert_state);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::device::test::test_get_alert_candidates -- --nocapture`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the query**

Add to `device.rs`:

```rust
#[derive(QueryableByName, Debug, Clone)]
pub struct DeviceAlertCandidate {
    #[diesel(sql_type = diesel::sql_types::Binary)]
    pub dev_eui: EUI64,
    #[diesel(sql_type = fields::sql_types::Uuid)]
    pub tenant_id: fields::Uuid,
    #[diesel(sql_type = diesel::sql_types::Text)]
    pub name: String,
    #[diesel(sql_type = diesel::sql_types::SmallInt)]
    pub alert_state: i16,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    pub is_inactive: bool,
}

#[cfg(feature = "postgres")]
pub async fn get_alert_candidates() -> Result<Vec<DeviceAlertCandidate>, Error> {
    diesel::sql_query(
        r#"
        select
            d.dev_eui,
            a.tenant_id,
            d.name,
            d.alert_state,
            (now() - d.last_seen_at) > (make_interval(secs => dp.uplink_interval) * 1.5) as is_inactive
        from device d
        inner join device_profile dp on d.device_profile_id = dp.id
        inner join application a on d.application_id = a.id
        where d.alert_enabled = true and d.last_seen_at is not null and dp.uplink_interval > 0
        "#,
    )
    .load(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, "".into()))
}

#[cfg(feature = "sqlite")]
pub async fn get_alert_candidates() -> Result<Vec<DeviceAlertCandidate>, Error> {
    diesel::sql_query(
        r#"
        select
            d.dev_eui,
            a.tenant_id,
            d.name,
            d.alert_state,
            (unixepoch('now') - unixepoch(d.last_seen_at)) > (dp.uplink_interval * 1.5) as is_inactive
        from device d
        inner join device_profile dp on d.device_profile_id = dp.id
        inner join application a on d.application_id = a.id
        where d.alert_enabled = 1 and d.last_seen_at is not null and dp.uplink_interval > 0
        "#,
    )
    .load(&mut get_async_db_conn().await?)
    .await
    .map_err(|e| Error::from_diesel(e, "".into()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres storage::device::test::test_get_alert_candidates -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/storage/device.rs
git commit -m "feat: add device alert candidate query"
```

---

## Task 8: Alert email sending

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Modify: `chirpstack/chirpstack/Cargo.toml`
- Create: `chirpstack/chirpstack/src/alert/email.rs`
- Modify: `chirpstack/chirpstack/src/alert/mod.rs` (add `pub mod email;`)
- Test: `chirpstack/chirpstack/src/alert/email.rs` (inline `#[cfg(test)] mod test`)

**Interfaces:**
- Consumes: Task 1's `Tenant.alert_smtp_*`/`alert_email_addresses` fields.
- Produces: `alert::email::EntityKind` (`Gateway`/`Device`), `alert::email::subject_for(...) -> String`, `alert::email::body_for(...) -> String`, `alert::email::send_transition_email(tenant: &Tenant, kind: EntityKind, entity_name: &str, went_inactive: bool)` (swallows per-recipient errors, logs via `warn!`), `alert::email::send_test_email(tenant: &Tenant) -> anyhow::Result<()>` (propagates the first error — used by the `TestAlertEmail` RPC so the caller gets real feedback).

- [ ] **Step 1: Write the failing test**

Create `chirpstack/chirpstack/src/alert/email.rs`:

```rust
use anyhow::{Context, Result};
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tracing::{info, warn};

use crate::storage::tenant::Tenant;

#[derive(Debug, Clone, Copy)]
pub enum EntityKind {
    Gateway,
    Device,
}

impl EntityKind {
    fn label(&self) -> &'static str {
        match self {
            EntityKind::Gateway => "Gateway",
            EntityKind::Device => "Device",
        }
    }
}

pub fn subject_for(tenant_name: &str, kind: EntityKind, entity_name: &str, went_inactive: bool) -> String {
    if went_inactive {
        format!("[{}] {} '{}' went inactive", tenant_name, kind.label(), entity_name)
    } else {
        format!("[{}] {} '{}' is active again", tenant_name, kind.label(), entity_name)
    }
}

pub fn body_for(tenant_name: &str, kind: EntityKind, entity_name: &str, went_inactive: bool) -> String {
    if went_inactive {
        format!(
            "{} '{}' in tenant '{}' has gone inactive.",
            kind.label(),
            entity_name,
            tenant_name
        )
    } else {
        format!(
            "{} '{}' in tenant '{}' is active again.",
            kind.label(),
            entity_name,
            tenant_name
        )
    }
}

fn build_message(tenant: &Tenant, to: &str, subject: String, body: String) -> Result<Message> {
    Message::builder()
        .from(tenant.alert_smtp_from_email.parse().context("parse from address")?)
        .to(to.parse().context("parse to address")?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .context("build email message")
}

async fn send(tenant: &Tenant, message: Message) -> Result<()> {
    let creds = Credentials::new(
        tenant.alert_smtp_username.clone(),
        tenant.alert_smtp_password.clone(),
    );

    let mailer: AsyncSmtpTransport<Tokio1Executor> = if tenant.alert_smtp_use_tls {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&tenant.alert_smtp_host)?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&tenant.alert_smtp_host)
    }
    .port(tenant.alert_smtp_port as u16)
    .credentials(creds)
    .build();

    info!(tenant_id = %tenant.id, host = %tenant.alert_smtp_host, "Sending alert email");
    mailer.send(message).await.map(|_| ()).context("send email")
}

pub async fn send_transition_email(tenant: &Tenant, kind: EntityKind, entity_name: &str, went_inactive: bool) {
    for addr in tenant.alert_email_addresses.iter().flatten() {
        let subject = subject_for(&tenant.name, kind, entity_name, went_inactive);
        let body = body_for(&tenant.name, kind, entity_name, went_inactive);

        match build_message(tenant, addr, subject, body) {
            Ok(msg) => {
                if let Err(e) = send(tenant, msg).await {
                    warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Sending alert email failed");
                }
            }
            Err(e) => {
                warn!(tenant_id = %tenant.id, to = %addr, error = %e, "Building alert email failed");
            }
        }
    }
}

pub async fn send_test_email(tenant: &Tenant) -> Result<()> {
    if tenant.alert_email_addresses.is_empty() {
        anyhow::bail!("no alert email addresses configured for this tenant");
    }

    for addr in tenant.alert_email_addresses.iter().flatten() {
        let subject = format!("[{}] ChirpStack alert test email", tenant.name);
        let body = "This is a test email from ChirpStack to verify your inactivity alert SMTP settings.".to_string();
        let msg = build_message(tenant, addr, subject, body)?;
        send(tenant, msg).await?;
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_subject_for() {
        assert_eq!(
            "[Acme] Gateway 'gw-01' went inactive",
            subject_for("Acme", EntityKind::Gateway, "gw-01", true)
        );
        assert_eq!(
            "[Acme] Device 'sensor-1' is active again",
            subject_for("Acme", EntityKind::Device, "sensor-1", false)
        );
    }

    #[test]
    fn test_body_for() {
        assert_eq!(
            "Gateway 'gw-01' in tenant 'Acme' has gone inactive.",
            body_for("Acme", EntityKind::Gateway, "gw-01", true)
        );
        assert_eq!(
            "Device 'sensor-1' in tenant 'Acme' is active again.",
            body_for("Acme", EntityKind::Device, "sensor-1", false)
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test alert::email::test -- --nocapture`
Expected: FAIL to compile — `lettre` isn't a dependency yet, and `email` isn't registered in `alert/mod.rs`.

- [ ] **Step 3: Add the `lettre` dependency**

In the workspace root `Cargo.toml`, add to `[workspace.dependencies]` (near the other HTTP/async dependencies):
```toml
lettre = { version = "0.11", default-features = false, features = ["tokio1-rustls-tls", "smtp-transport", "builder"] }
```

In `chirpstack/chirpstack/Cargo.toml`, add under a new `# Alerting` comment block, matching the `reqwest.workspace = true` style already used there:
```toml
lettre.workspace = true
```

Run `cargo check -p chirpstack` from the repo root to confirm the dependency resolves. If any of the `lettre` 0.11 method names used in Step 1 (`relay`, `builder_dangerous`, `Tokio1Executor`, `.credentials()`, `.port()`) don't match what actually resolves once `Cargo.lock` picks a version, adjust to match `lettre`'s actual public API for the resolved version — check `cargo doc -p lettre --open` or the crate's docs.rs page.

- [ ] **Step 4: Register the module**

In `chirpstack/chirpstack/src/alert/mod.rs`, add `pub mod email;` next to `pub mod state;`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test alert::email::test -- --nocapture`
Expected: PASS (`test_subject_for`, `test_body_for`)

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock chirpstack/chirpstack/Cargo.toml chirpstack/chirpstack/src/alert
git commit -m "feat: add SMTP-based alert email sending"
```

---

## Task 9: Reaper loop and config wiring

**Files:**
- Modify: `chirpstack/chirpstack/src/config.rs`
- Modify: `chirpstack/chirpstack/src/alert/mod.rs`
- Modify: `chirpstack/chirpstack/src/cmd/root.rs`
- Test: `chirpstack/chirpstack/src/alert/mod.rs` (inline `#[cfg(test)] mod test`, DB-backed)

**Interfaces:**
- Consumes: Task 5's `evaluate()`/`AlertState`/`Transition`, Task 6's `gateway::get_alert_candidates()`/`set_alert_state()`, Task 7's `device::get_alert_candidates()`/`set_alert_state()`, Task 8's `email::send_transition_email()`, Task 4's `alert_event::insert()`.
- Produces: `alert::setup() -> ()` (spawns the background loop, called from `cmd/root.rs`), `alert::scan_gateways() -> anyhow::Result<()>`, `alert::scan_devices() -> anyhow::Result<()>`.

- [ ] **Step 1: Write the failing test**

Add to `chirpstack/chirpstack/src/alert/mod.rs`:

```rust
#[cfg(test)]
mod test {
    use chrono::Duration;

    use super::*;
    use crate::storage::{self, gateway};

    #[tokio::test]
    async fn test_scan_gateways_records_first_observation_without_email() {
        let _guard = storage::test::prepare().await;
        let t = storage::tenant::test::create_tenant().await; // alert_email_addresses is empty by default

        let gw = gateway::create(gateway::Gateway {
            gateway_id: lrwn::EUI64::from_be_bytes([1, 2, 3, 4, 5, 6, 7, 8]),
            tenant_id: t.id,
            name: "test-gw".into(),
            alert_enabled: true,
            stats_interval_secs: 30,
            last_seen_at: Some(chrono::Utc::now() - Duration::seconds(600)),
            ..Default::default()
        }).await.unwrap();

        scan_gateways().await.unwrap();

        let gw_get = gateway::get(&gw.gateway_id).await.unwrap();
        // First observation: alert_state moves from 0 (unknown) straight to 2 (inactive),
        // recorded silently — no email possible anyway since the tenant has no addresses.
        assert_eq!(2, gw_get.alert_state);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chirpstack/chirpstack && cargo test --features postgres alert::test::test_scan_gateways_records_first_observation_without_email -- --nocapture`
Expected: FAIL to compile — `scan_gateways` doesn't exist yet.

- [ ] **Step 3: Add the config field**

In `chirpstack/chirpstack/src/config.rs`, add to the existing `Monitoring` struct:
```rust
#[serde(with = "humantime_serde")]
pub alert_interval: Duration,
```
and to `Monitoring`'s `Default` impl (or wherever its defaults are set — match the existing `per_device_event_log_ttl` default's style):
```rust
alert_interval: Duration::from_secs(30 * 60),
```

- [ ] **Step 4: Implement the reaper**

Replace `chirpstack/chirpstack/src/alert/mod.rs`'s contents with:

```rust
pub mod email;
pub mod state;

use tokio::time::sleep;
use tracing::{error, info, trace};
use uuid::Uuid;

use crate::config;
use crate::storage::{alert_event, device, fields, gateway, tenant};
use email::EntityKind;
use state::{evaluate, AlertState, Transition};

pub async fn setup() {
    info!("Setting up inactivity alert reaper loop");
    tokio::spawn(async move {
        reaper_loop().await;
    });
}

async fn reaper_loop() {
    let conf = config::get();

    loop {
        trace!("Starting inactivity alert scan");

        if let Err(err) = scan_gateways().await {
            error!(error = %err, "Scanning gateways for inactivity alerts failed");
        }
        if let Err(err) = scan_devices().await {
            error!(error = %err, "Scanning devices for inactivity alerts failed");
        }

        sleep(conf.monitoring.alert_interval).await;
    }
}

pub async fn scan_gateways() -> anyhow::Result<()> {
    let candidates = gateway::get_alert_candidates().await?;

    for c in candidates {
        let previous = AlertState::from_i16(c.alert_state);
        let (new_state, transition) = evaluate(previous, c.is_inactive);

        match transition {
            Transition::None => continue,
            Transition::RecordOnly => {
                gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await?;
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                if let Ok(t) = tenant::get(&c.tenant_id.into()).await {
                    let email_sent = !t.alert_email_addresses.is_empty();
                    if email_sent {
                        email::send_transition_email(&t, EntityKind::Gateway, &c.name, went_inactive).await;
                    }
                    alert_event::insert(alert_event::AlertEvent {
                        id: fields::Uuid::from(Uuid::new_v4()),
                        entity_type: alert_event::ENTITY_TYPE_GATEWAY,
                        entity_id: c.gateway_id,
                        tenant_id: c.tenant_id.clone(),
                        previous_state: previous.to_i16(),
                        new_state: new_state.to_i16(),
                        created_at: chrono::Utc::now(),
                        email_sent,
                    })
                    .await?;
                }
                gateway::set_alert_state(&c.gateway_id, new_state.to_i16()).await?;
            }
        }
    }

    Ok(())
}

pub async fn scan_devices() -> anyhow::Result<()> {
    let candidates = device::get_alert_candidates().await?;

    for c in candidates {
        let previous = AlertState::from_i16(c.alert_state);
        let (new_state, transition) = evaluate(previous, c.is_inactive);

        match transition {
            Transition::None => continue,
            Transition::RecordOnly => {
                device::set_alert_state(&c.dev_eui, new_state.to_i16()).await?;
            }
            Transition::WentInactive | Transition::Recovered => {
                let went_inactive = matches!(transition, Transition::WentInactive);
                if let Ok(t) = tenant::get(&c.tenant_id.into()).await {
                    let email_sent = !t.alert_email_addresses.is_empty();
                    if email_sent {
                        email::send_transition_email(&t, EntityKind::Device, &c.name, went_inactive).await;
                    }
                    alert_event::insert(alert_event::AlertEvent {
                        id: fields::Uuid::from(Uuid::new_v4()),
                        entity_type: alert_event::ENTITY_TYPE_DEVICE,
                        entity_id: c.dev_eui,
                        tenant_id: c.tenant_id.clone(),
                        previous_state: previous.to_i16(),
                        new_state: new_state.to_i16(),
                        created_at: chrono::Utc::now(),
                        email_sent,
                    })
                    .await?;
                }
                device::set_alert_state(&c.dev_eui, new_state.to_i16()).await?;
            }
        }
    }

    Ok(())
}
```

Note: `tenant::get()` takes a plain `uuid::Uuid` (see `tenant.rs`'s existing `get()` signature); `c.tenant_id` is `fields::Uuid`. If `fields::Uuid` doesn't implement `Into<uuid::Uuid>` directly, use whatever conversion `gateway.rs`/`device.rs` already use elsewhere to go from `fields::Uuid` back to a plain `Uuid` (e.g. a `Deref` or explicit `.into_uuid()` — check `fields/mod.rs`) instead of `.into()`.

Then re-add the `mod test { ... }` block from Step 1 at the bottom of the file.

- [ ] **Step 5: Wire into startup**

In `chirpstack/chirpstack/src/cmd/root.rs`, add `use crate::alert;` to the import group, and insert `alert::setup().await;` immediately after `downlink::setup().await;` and before `fuota::setup().await;`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd chirpstack/chirpstack && cargo test --features postgres alert::test::test_scan_gateways_records_first_observation_without_email -- --nocapture`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add chirpstack/chirpstack/src/config.rs chirpstack/chirpstack/src/alert/mod.rs chirpstack/chirpstack/src/cmd/root.rs
git commit -m "feat: wire up inactivity alert reaper background loop"
```

---

## Task 10: Proto changes

**Files:**
- Modify: `api/proto/api/tenant.proto`
- Modify: `api/proto/api/gateway.proto`
- Modify: `api/proto/api/device.proto`

**Interfaces:**
- Produces: `api::Tenant` gains `alert_smtp_host`, `alert_smtp_port`, `alert_smtp_username`, `alert_smtp_password`, `alert_smtp_from_email`, `alert_smtp_use_tls`, `alert_email_addresses` (fields 11-17); `TenantService.TestAlertEmail(TestAlertEmailRequest{tenant_id}) returns (google.protobuf.Empty)`; `api::Gateway` gains `optional bool alert_enabled` (field 10); `api::Device` gains `optional bool alert_enabled` (field 11). Generated Rust (`chirpstack_api`) and TS bindings.

- [ ] **Step 1: Edit `tenant.proto`**

Add to the `Tenant` message, after `dev_addr_prefixes = 10;`:
```proto
  // SMTP host used for sending inactivity alert emails.
  string alert_smtp_host = 11;
  // SMTP port.
  uint32 alert_smtp_port = 12;
  // SMTP username.
  string alert_smtp_username = 13;
  // SMTP password.
  string alert_smtp_password = 14;
  // From email address used for alert emails.
  string alert_smtp_from_email = 15;
  // Use TLS when connecting to the SMTP relay.
  bool alert_smtp_use_tls = 16;
  // Email addresses that receive gateway / device inactivity alerts.
  // An empty list means alerting is effectively disabled for this tenant.
  repeated string alert_email_addresses = 17;
```

Add to the `TenantService` service definition, alongside the other RPCs (model on `AddUser`'s POST-with-body style):
```proto
  // Send a test email using the tenant's currently saved alert SMTP settings.
  rpc TestAlertEmail(TestAlertEmailRequest) returns (google.protobuf.Empty) {
    option (google.api.http) = {
      post: "/api/tenants/{tenant_id}/alerts/test"
      body: "*"
    };
  }
```

Add a new message near `DeleteTenantUserRequest`:
```proto
message TestAlertEmailRequest {
  // Tenant ID (UUID).
  string tenant_id = 1;
}
```

- [ ] **Step 2: Edit `gateway.proto`**

Add to the `Gateway` message, after `downlink_priority = 9;`:
```proto
  // Enable inactivity alert emails for this gateway.
  // When not set by the client, defaults to true.
  optional bool alert_enabled = 10;
```

- [ ] **Step 3: Edit `device.proto`**

Add to the `Device` message, after `join_eui = 10;`:
```proto
  // Enable inactivity alert emails for this device.
  // When not set by the client, defaults to true.
  optional bool alert_enabled = 11;
```

- [ ] **Step 4: Regenerate bindings**

Run: `make proto` from the repo root (confirm the exact target name in the root `Makefile` if `proto` isn't it — it's the pipeline referenced in the spec's "Existing behavior" section: proto → Rust via `tonic_prost_build`, and → TS via `protoc-gen-grpc-web`).

- [ ] **Step 5: Verify it compiles**

Run: `cargo check -p chirpstack_api` from the repo root.
Expected: compiles cleanly with the new generated fields/RPC present in `chirpstack_api::api::Tenant`, `::Gateway`, `::Device`, and a new `TestAlertEmailRequest` / `TenantServiceClient::test_alert_email` (Rust) / `TenantServiceClient.testAlertEmail` (TS, used in Task 14).

- [ ] **Step 6: Commit**

```bash
git add api/proto chirpstack/chirpstack/src/api ui/src/store  # regenerated files land under these paths per the make proto pipeline
git commit -m "feat: add alert proto fields and TestAlertEmail RPC"
```

---

## Task 11: Tenant API handler

**Files:**
- Modify: `chirpstack/chirpstack/src/api/tenant.rs`

**Interfaces:**
- Consumes: Task 8's `alert::email::send_test_email()`, Task 10's generated `api::Tenant` fields and `api::TestAlertEmailRequest`.
- Produces: `TenantService::test_alert_email` RPC handler; `get`/`create`/`update` handlers carry the new fields both directions.

- [ ] **Step 1: Extend the `get` conversion**

In the `get()` handler's `api::Tenant { ... }` construction, add:
```rust
alert_smtp_host: t.alert_smtp_host,
alert_smtp_port: t.alert_smtp_port as u32,
alert_smtp_username: t.alert_smtp_username,
alert_smtp_password: t.alert_smtp_password,
alert_smtp_from_email: t.alert_smtp_from_email,
alert_smtp_use_tls: t.alert_smtp_use_tls,
alert_email_addresses: t.alert_email_addresses.iter().flatten().cloned().collect(),
```

- [ ] **Step 2: Extend the `create` and `update` handlers**

In both handlers, wherever the storage `tenant::Tenant { ... }` struct is built from `req_tenant`, add:
```rust
alert_smtp_host: req_tenant.alert_smtp_host.clone(),
alert_smtp_port: req_tenant.alert_smtp_port as i32,
alert_smtp_username: req_tenant.alert_smtp_username.clone(),
alert_smtp_password: req_tenant.alert_smtp_password.clone(),
alert_smtp_from_email: req_tenant.alert_smtp_from_email.clone(),
alert_smtp_use_tls: req_tenant.alert_smtp_use_tls,
alert_email_addresses: fields::StringVec::new(
    req_tenant.alert_email_addresses.iter().map(|s| Some(s.clone())).collect(),
),
```

- [ ] **Step 3: Add the `test_alert_email` handler**

Add a new method to the `impl TenantService for Tenant` block (model the shape — request parsing, `self.validator.validate(...)`, response — on the existing `delete_user` handler in this file):

```rust
async fn test_alert_email(
    &self,
    request: Request<api::TestAlertEmailRequest>,
) -> Result<Response<()>, Status> {
    let req = request.get_ref();
    let tenant_id = Uuid::from_str(&req.tenant_id).map_err(|e| e.status())?;

    self.validator
        .validate(
            request.extensions(),
            validator::ValidateTenantAccess::new(validator::Flag::Update, tenant_id),
        )
        .await?;

    let t = tenant::get(&tenant_id).await.map_err(|e| e.status())?;
    crate::alert::email::send_test_email(&t)
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

    Ok(Response::new(()))
}
```

(Match this file's exact `validator::ValidateTenantAccess`/`Flag` import path and usage — copy from an existing tenant-scoped handler such as `update()` rather than from `delete_user`, since `delete_user` uses `ValidateTenantUserAccess` for a different resource.)

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `cd chirpstack/chirpstack && cargo test --features postgres api::tenant:: -- --nocapture`
Expected: PASS (existing tenant API tests unaffected; if any existing test constructs an `api::Tenant` literal, it will need the 7 new fields added — fix those call sites).

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/api/tenant.rs
git commit -m "feat: expose tenant alert config and TestAlertEmail over the API"
```

---

## Task 12: Gateway API handler

**Files:**
- Modify: `chirpstack/chirpstack/src/api/gateway.rs`

**Interfaces:**
- Consumes: Task 2's `gateway::set_alert_enabled()`, Task 10's generated `optional bool alert_enabled` on `api::Gateway`.
- Produces: `create`/`update`/`get` handlers carry `alert_enabled` both directions, defaulting to `true` on create when the client omits it.

- [ ] **Step 1: Extend the `get` conversion**

In the `get()` handler's `api::Gateway { ... }` construction, add:
```rust
alert_enabled: Some(gw.alert_enabled),
```

- [ ] **Step 2: Extend the `create` handler**

Where the storage `gateway::Gateway { ... }` struct is built from the request, add:
```rust
alert_enabled: req_gateway.alert_enabled.unwrap_or(true),
alert_state: 0,
```

- [ ] **Step 3: Extend the `update` handler**

After the existing `gateway::update(gw).await.map_err(|e| e.status())?;` call, add:
```rust
if let Some(enabled) = req_gateway.alert_enabled {
    gateway::set_alert_enabled(&gateway_id, enabled)
        .await
        .map_err(|e| e.status())?;
}
```

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `cd chirpstack/chirpstack && cargo test --features postgres api::gateway:: -- --nocapture`
Expected: PASS (fix any existing test's `api::Gateway { ... }` literal to include `alert_enabled: Some(true)` or similar).

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/api/gateway.rs
git commit -m "feat: expose gateway alert_enabled over the API"
```

---

## Task 13: Device API handler

**Files:**
- Modify: `chirpstack/chirpstack/src/api/device.rs`

**Interfaces:**
- Consumes: Task 3's `device::set_alert_enabled()`, Task 10's generated `optional bool alert_enabled` on `api::Device`.
- Produces: `create`/`update`/`get` handlers carry `alert_enabled` both directions, identical shape to Task 12.

- [ ] **Step 1: Extend the `get` conversion**

In the `get()` handler's `api::Device { ... }` construction, add:
```rust
alert_enabled: Some(d.alert_enabled),
```

- [ ] **Step 2: Extend the `create` handler**

Where the storage `device::Device { ... }` struct is built, add:
```rust
alert_enabled: req_device.alert_enabled.unwrap_or(true),
alert_state: 0,
```

- [ ] **Step 3: Extend the `update` handler**

After the existing `device::update(d).await.map_err(|e| e.status())?;` call, add:
```rust
if let Some(enabled) = req_device.alert_enabled {
    device::set_alert_enabled(&dev_eui, enabled)
        .await
        .map_err(|e| e.status())?;
}
```

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `cd chirpstack/chirpstack && cargo test --features postgres api::device:: -- --nocapture`
Expected: PASS (fix any existing test's `api::Device { ... }` literal similarly to Task 12).

- [ ] **Step 5: Commit**

```bash
git add chirpstack/chirpstack/src/api/device.rs
git commit -m "feat: expose device alert_enabled over the API"
```

---

## Task 14: Tenant Alerts UI

**Files:**
- Modify: `ui/src/views/tenants/TenantForm.tsx`
- Modify: `ui/src/store/TenantStore.ts`
- Modify: `ui/src/views/tenants/EditTenant.tsx` (only if the "Send test email" button needs a callback wired at this level — otherwise `TenantForm.tsx` alone can call the store directly)

**Interfaces:**
- Consumes: Task 10's regenerated `Tenant`/`TestAlertEmailRequest` TS types.
- Produces: a 4th "Alerts" tab in `TenantForm.tsx` with SMTP fields, a repeatable email-address list, and a "Send test email" button; `TenantStore.testAlertEmail(req, callbackFunc)`.

- [ ] **Step 1: Add the store method**

In `ui/src/store/TenantStore.ts`, add (model on the existing `addUser` method):
```ts
testAlertEmail = (req: TestAlertEmailRequest, callbackFunc: () => void) => {
  this.client.testAlertEmail(req, SessionStore.getMetadata(), err => {
    if (err !== null) {
      HandleError(err);
      return;
    }

    notification.success({ message: "Test email sent", duration: 3 });
    callbackFunc();
  });
};
```
Add `TestAlertEmailRequest` to this file's existing import block from the generated `tenant_pb` module.

- [ ] **Step 2: Add the Alerts tab**

In `ui/src/views/tenants/TenantForm.tsx`, add a 4th entry to `tabItems` (alongside General / Tags / DevAddr prefixes), following the file's existing tab-content structure:

```tsx
{
  key: "alerts",
  label: "Alerts",
  children: (
    <>
      <Form.Item label="SMTP host" name="alertSmtpHost">
        <Input disabled={props.disabled} />
      </Form.Item>
      <Form.Item label="SMTP port" name="alertSmtpPort">
        <InputNumber disabled={props.disabled} min={1} max={65535} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item label="SMTP username" name="alertSmtpUsername">
        <Input disabled={props.disabled} />
      </Form.Item>
      <Form.Item label="SMTP password" name="alertSmtpPassword">
        <Input.Password disabled={props.disabled} />
      </Form.Item>
      <Form.Item label="From email address" name="alertSmtpFromEmail">
        <Input disabled={props.disabled} />
      </Form.Item>
      <Form.Item
        label="Use TLS"
        name="alertSmtpUseTls"
        tooltip="Use a TLS connection when sending alert emails through this SMTP relay."
        valuePropName="checked"
      >
        <Switch disabled={props.disabled} />
      </Form.Item>

      <Form.List name="alertEmailAddressesList">
        {(fields, { add, remove }) => (
          <>
            {fields.map(field => (
              <Row gutter={24} key={field.key}>
                <Col span={22}>
                  <Form.Item {...field}>
                    <Input placeholder="email address" />
                  </Form.Item>
                </Col>
                <Col span={2}>
                  <MinusCircleOutlined onClick={() => remove(field.name)} />
                </Col>
              </Row>
            ))}
            <Form.Item>
              <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                Add alert email address
              </Button>
            </Form.Item>
          </>
        )}
      </Form.List>

      <Form.Item>
        <Button
          onClick={() => {
            if (!props.initialValues.getId()) {
              return;
            }
            const req = new TestAlertEmailRequest();
            req.setTenantId(props.initialValues.getId());
            TenantStore.testAlertEmail(req, () => {});
          }}
        >
          Send test email
        </Button>
      </Form.Item>
    </>
  ),
},
```

Add `TestAlertEmailRequest` and `TenantStore` to this file's imports, and `Switch` if not already imported.

- [ ] **Step 3: Wire the new fields into `onFinish`**

In `TenantForm.tsx`'s `onFinish`, alongside the existing `tagsMap`/`devAddrPrefixesList` handling, add:
```ts
tenant.setAlertSmtpHost(v.alertSmtpHost || "");
tenant.setAlertSmtpPort(v.alertSmtpPort || 587);
tenant.setAlertSmtpUsername(v.alertSmtpUsername || "");
tenant.setAlertSmtpPassword(v.alertSmtpPassword || "");
tenant.setAlertSmtpFromEmail(v.alertSmtpFromEmail || "");
tenant.setAlertSmtpUseTls(v.alertSmtpUseTls || false);
tenant.setAlertEmailAddressesList(v.alertEmailAddressesList || []);
```

- [ ] **Step 4: Manual verification**

Run the UI dev server (`cd ui && npm start` or this project's existing dev script — check `ui/package.json`) alongside the backend, open a tenant's edit page, confirm the "Alerts" tab renders, fill in SMTP settings against a local MailHog instance (`docker run -p 1025:1025 -p 8025:8025 mailhog/mailhog`, host `localhost`, port `1025`, TLS off), click "Send test email," and confirm the message arrives in MailHog's web UI (`http://localhost:8025`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/views/tenants/TenantForm.tsx ui/src/store/TenantStore.ts
git commit -m "feat: add tenant Alerts settings UI"
```

---

## Task 15: Gateway Alerts toggle UI

**Files:**
- Modify: `ui/src/views/gateways/GatewayForm.tsx`

**Interfaces:**
- Consumes: Task 10's regenerated `Gateway` TS type with `alertEnabled`/`hasAlertEnabled`/`setAlertEnabled`.
- Produces: an "Enable inactivity alerts" checkbox on the gateway edit form.

- [ ] **Step 1: Add the `Switch` field**

In `ui/src/views/gateways/GatewayForm.tsx`, add `Switch` to the antd import if not already present. Add, near the existing `statsInterval`/`downlinkPriority` fields:
```tsx
<Form.Item
  label="Enable inactivity alerts"
  name="alertEnabled"
  tooltip="When enabled, the tenant's configured alert email addresses receive a notification when this gateway goes inactive (and again when it recovers)."
  valuePropName="checked"
>
  <Switch disabled={props.disabled} />
</Form.Item>
```

- [ ] **Step 2: Set the default and wire `onFinish`**

In this form's `initialValues` construction (wherever the component maps `props.initialValues.toObject()` into form state — for a *new* gateway this should default `alertEnabled` to `true`), and in `onFinish`, add:
```ts
g.setAlertEnabled(v.alertEnabled);
```

- [ ] **Step 3: Manual verification**

Run the UI dev server, open the "create gateway" form, confirm the checkbox is checked by default; open an existing gateway's edit form, confirm it reflects the stored value; toggle it off and save, then re-open and confirm it persisted.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/gateways/GatewayForm.tsx
git commit -m "feat: add gateway inactivity alert toggle to UI"
```

---

## Task 16: Device Alerts toggle UI

**Files:**
- Modify: `ui/src/views/devices/DeviceForm.tsx`

**Interfaces:**
- Consumes: Task 10's regenerated `Device` TS type with `alertEnabled`/`hasAlertEnabled`/`setAlertEnabled`.
- Produces: an "Enable inactivity alerts" checkbox on the device edit form, alongside the existing `isDisabled`/`skipFcntCheck` checkboxes.

- [ ] **Step 1: Add the `Switch` field**

In `ui/src/views/devices/DeviceForm.tsx`, add right after the existing `skipFcntCheck` `Form.Item` (same tab, same visual grouping as the other device-behavior toggles):
```tsx
<Form.Item
  label="Enable inactivity alerts"
  name="alertEnabled"
  tooltip="When enabled, the tenant's configured alert email addresses receive a notification when this device goes inactive (and again when it recovers)."
  valuePropName="checked"
>
  <Switch disabled={props.disabled} />
</Form.Item>
```

- [ ] **Step 2: Set the default and wire `onFinish`**

Same as Task 15: default `true` for a new device, and in `onFinish` add:
```ts
d.setAlertEnabled(v.alertEnabled);
```
(alongside the existing `d.setIsDisabled(...)`, `d.setSkipFcntCheck(...)` lines).

- [ ] **Step 3: Manual verification**

Run the UI dev server, confirm the same create/edit/persist behavior as Task 15, but for a device.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/devices/DeviceForm.tsx
git commit -m "feat: add device inactivity alert toggle to UI"
```
