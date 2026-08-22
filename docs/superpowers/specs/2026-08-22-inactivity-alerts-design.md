# Inactivity Alerts — Design Spec

Date: 2026-08-22
Status: Approved for planning

## Summary

Add an alerting feature that emails a tenant's configured recipients when a
gateway or device (sensor) transitions between active and non-active. Each
tenant configures its own SMTP relay and one or more alert email addresses.
Alerts are on by default for every gateway/device in a tenant and can be
disabled individually per entity.

## Goals

- Detect gateway and device inactivity using thresholds ChirpStack already
  computes, with no new per-entity threshold configuration.
- Notify tenant-configured email addresses when an entity goes inactive, and
  again when it recovers.
- Let a tenant enable/disable the feature per gateway and per device, on top
  of a tenant-wide on/off (implied by whether any alert email address is
  configured).
- Keep the implementation consistent with existing ChirpStack patterns
  (credential storage, background task structure, proto/API conventions).

## Non-goals (deferred)

- Per-entity custom inactivity thresholds (gateway uses its own
  `stats_interval_secs`-derived threshold; device uses its device profile's
  `uplink_interval` — no override field).
- Alerting on "never seen" entities (no baseline to transition from).
- A global/server-wide SMTP relay option (tenant-level SMTP was chosen
  explicitly over global).
- Alert-history UI (the audit table is written so this is cheap to add
  later, but no UI is built now).
- Non-email delivery channels (SMS, webhook, Slack, etc.).
- Retry/backoff for failed SMTP sends, or alert throttling/digesting beyond
  one email per transition.

## Existing behavior this builds on

- Gateway online/offline is computed on read, not stored: `Utc::now() -
  last_seen_at > Duration::seconds(stats_interval_secs * 2)` in
  `chirpstack/chirpstack/src/api/gateway.rs` (list handler) and duplicated in
  raw SQL in `chirpstack/chirpstack/src/storage/gateway.rs`
  (`get_counts_by_state`). `stats_interval_secs` is a per-gateway column,
  default 30s.
- Devices have no derived active/inactive state today, only a raw
  `last_seen_at` timestamp on `Device`
  (`chirpstack/chirpstack/src/storage/device.rs`). `DeviceProfile` already
  has `uplink_interval` (seconds) whose proto doc explicitly says: "If the
  uplink interval has expired and no uplink has been received, the device is
  considered inactive." This is the field to reuse for the device threshold.
- No background/periodic job scheduler exists generically. The closest
  reusable pattern is the downlink scheduler
  (`chirpstack/chirpstack/src/downlink/scheduler.rs`,
  `chirpstack/chirpstack/src/downlink/mod.rs`): `tokio::spawn(async move {
  loop { ...; sleep(interval).await; } })`, wired up in
  `chirpstack/chirpstack/src/cmd/root.rs`.
- No email-sending capability exists anywhere in ChirpStack today. This
  feature introduces the first one (new `lettre` dependency).
- No encryption-at-rest exists for any stored credential. Integration
  credentials (e.g. `AwsSnsConfiguration.secret_access_key`,
  `AzureServiceBusConfiguration.connection_string` in
  `chirpstack/chirpstack/src/storage/application.rs`) are stored as
  plaintext JSON. Tenant SMTP credentials will follow the same convention
  for consistency; this is a known, pre-existing limitation of the codebase,
  not a gap introduced by this feature.

## Data model & migrations

**`tenant`** — new columns:

- `alert_smtp_host text not null default ''`
- `alert_smtp_port smallint not null default 587`
- `alert_smtp_username text not null default ''`
- `alert_smtp_password text not null default ''` (plaintext, matching
  existing integration-credential convention)
- `alert_smtp_from_email text not null default ''`
- `alert_smtp_use_tls boolean not null default true`
- `alert_email_addresses` — a string list, using the same
  Postgres/SQLite-portable custom-type pattern ChirpStack already uses for
  `dev_addr_prefixes` (`fields::DevAddrPrefixVec`). An empty list means
  alerting is effectively off for the tenant — no separate master-switch
  column is needed.

**`gateway`** — new columns:

- `alert_enabled boolean not null default true`
- `alert_state smallint not null default 0` (0 = unknown/not yet evaluated,
  1 = active, 2 = inactive) — the reaper's per-scan "last known state,"
  read and written every scan to detect transitions without recomputing
  history.

**`device`** — same two new columns: `alert_enabled`, `alert_state`, same
semantics.

**New `alert_event` table** (append-only audit log):

- `id` (uuid, pk)
- `entity_type` (smallint: 0 = gateway, 1 = device)
- `entity_id` (text — `gateway_id` or `dev_eui`)
- `tenant_id` (uuid, fk)
- `previous_state` (smallint)
- `new_state` (smallint)
- `created_at` (timestamptz)
- `email_sent` (boolean)

This table is written by the reaper whenever it acts on a transition; it is
never read by the reaper itself (that's what `alert_state` is for). It
exists so a future "alert history" view has data to show without a later
migration.

Migrations follow the existing convention:
`migrations_postgres/YYYY-MM-DD-HHMMSS-0000_<snake_case_description>/` (and
mirrored in `migrations_sqlite/`), each with `up.sql` + `down.sql`, followed
by regenerating `schema_postgres.rs` / `schema_sqlite.rs` / `schema.rs`.

## Background alert monitor

New module `chirpstack/chirpstack/src/alert/mod.rs`, spawned from
`chirpstack/chirpstack/src/cmd/root.rs` the same way the downlink scheduler
is spawned:

```
loop {
    sleep(interval).await;
    scan_gateways().await;
    scan_devices().await;
}
```

`interval` is configurable via a new `[monitoring]` block in
`chirpstack.toml` (e.g. `alert_interval`), default 30 minutes.

**`scan_gateways()`**: query gateways where `alert_enabled = true` and
`last_seen_at is not null` (never-seen gateways are skipped entirely, per
scope). For each: `is_inactive = now - last_seen_at > stats_interval_secs *
2` (existing formula, reused as-is) → `new_state`.

- If stored `alert_state == Unknown`: record `new_state`, send no email.
  This avoids a spurious alert storm on first rollout for gateways/devices
  that are already quiet when the migration runs.
- Else if `new_state != alert_state`: send the transition email (only if
  the tenant's `alert_email_addresses` is non-empty), insert an
  `alert_event` row, update `alert_state`.
- Else: no-op.

**`scan_devices()`**: same shape, joined with the device's `DeviceProfile`
for `uplink_interval` as the threshold instead of the gateway formula.
Devices whose profile has `uplink_interval == 0` are skipped entirely (0
means "no expected interval configured" — not "always inactive").

Both scans are done as a small number of batched SQL queries (not a
per-row round trip) to keep this cheap at scale.

**Toggling `alert_enabled` off and back on**: turning the toggle off does
not delete history, but turning it back on resets `alert_state` to
`Unknown`. This makes re-enabling behave like a brand-new entity — the next
scan just records the observed state silently, and only a subsequent
transition can trigger an email. This avoids an immediate alert firing the
moment someone re-enables alerting on an entity that happens to be inactive
at that instant.

## Email delivery

New `chirpstack/chirpstack/src/alert/email.rs`, using the `lettre` crate
(new dependency) against the tenant's own SMTP settings
(`alert_smtp_host`/`port`/`username`/`password`/`from_email`/`use_tls`).

Two plain-text templates:

- **Went inactive**: names the entity (gateway or device), its tenant, and
  the last-seen timestamp.
- **Recovered**: names the entity, its tenant, and the recovery timestamp.

Sent to every address in `tenant.alert_email_addresses`. If the SMTP send
fails, the error is logged but `alert_state` is still updated — a broken
relay should not cause the reaper to retry the same send every scan cycle.
Retry/backoff is explicitly deferred (see Non-goals).

## API / proto changes

Existing Create/Update/Get messages for `Tenant`, `Gateway`, and `Device`
gain new fields:

- `api/proto/api/tenant.proto` — `Tenant` message gains
  `alert_smtp_host`, `alert_smtp_port`, `alert_smtp_username`,
  `alert_smtp_password`, `alert_smtp_from_email`, `alert_smtp_use_tls`,
  `repeated string alert_email_addresses`.
- `api/proto/api/gateway.proto` — `Gateway` message gains `bool
  alert_enabled`.
- `api/proto/api/device.proto` — `Device` message gains `bool
  alert_enabled`.

One new RPC: `TenantService.TestAlertEmail(TestAlertEmailRequest{tenant_id})
returns (google.protobuf.Empty)` — sends a one-off test message using the
tenant's currently-saved SMTP settings and returns an error if the send
fails, backing the "Send test email" UI button.

Generated Rust and TypeScript/gRPC-Web bindings are regenerated via the
existing `make proto` pipeline.

## UI changes

- Tenant edit page: new "Alerts" section with the SMTP fields, a
  repeatable email-address list input, and a "Send test email" button that
  sends a one-off test message through the configured SMTP settings so a
  tenant can confirm the config works before relying on it.
- Gateway edit form: "Enable inactivity alerts" checkbox, checked by
  default for new gateways.
- Device edit form: same checkbox (general tab), checked by default for
  new devices.

## Testing

- Rust unit tests for the transition-detection logic as a pure function
  (given `last_seen_at`, threshold, previous `alert_state` → `new_state` +
  whether to alert) — independently testable without DB or network.
- Rust unit tests for email template rendering.
- Storage-layer tests (existing test-container pattern) for the new
  migration and CRUD of the new tenant/gateway/device fields.
- Manual verification against a local SMTP capture tool (e.g. MailHog),
  called out explicitly since no SMTP integration-test harness exists in
  the repo today.

