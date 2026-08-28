# ChirpStack open-source LoRaWAN(R) Network Server

![CI](https://github.com/chirpstack/chirpstack/actions/workflows/main.yml/badge.svg?branch=master)

ChirpStack is an open-source LoRaWAN(R) Network Server which can be used to set
up LoRaWAN networks. ChirpStack provides a web-interface for the management of
gateways, devices and tenants as well to set up data integrations with the major
cloud providers, databases and services commonly used for handling device data.
ChirpStack provides a gRPC based API that can be used to integrate or extend
ChirpStack.

## Fork-specific features

This fork extends upstream ChirpStack with the following, on top of the
standard feature set:

### Inactivity alerts

* Per-tenant SMTP configuration (host, port, TLS, credentials, from-address,
  and one or more alert recipient addresses), with a test-email action.
* Per-gateway and per-device "alert enabled" toggle.
* A background reaper loop that periodically scans for gateways/devices that
  have gone inactive (or recovered) and sends a transition email — subject
  and body include the tenant name, and for devices, the owning application
  name (e.g. `Device 'X' (application 'Y') in tenant 'Z' has gone inactive.`).
* An audit log (`alert_event`) recording every state transition and whether
  the notification email was actually delivered.

### Map improvements

* Per-application and per-gateway custom map pin icons (including added
  icon options such as `tower-cell` and `gauge`).
* Gateways and devices without a real (non-zero) location are no longer
  plotted on the map — previously an unset location defaulted to `(0, 0)`
  and rendered a marker at Null Island.
* The tenant map now plots devices (not just gateways), with a popup
  showing device status, device profile, and the last gateway/RSSI that
  detected it.
* A "Coverage" mode: an empirical signal-coverage heatmap derived from
  devices' last-seen-gateway RSSI, toggleable alongside the normal markers
  view.
* Plain latitude/longitude number inputs on the gateway form, alongside the
  existing draggable-map picker.
* Fixed: gateway stats updates no longer silently overwrite a manually-set
  gateway location.
* Fixed: the map no longer crashes when nothing on it has a known location
  (previously threw trying to compute bounds from zero points).

### Device management

* Latitude/longitude fields on the device create/edit form.
* Search by name or DevEUI on the device list page.

### Responsive UI

* The app shell, tables/forms, dashboards, region details, device
  activation, integration pickers, and the remaining forms (tenant-user,
  multicast group, relay, FUOTA) all adapt to narrow/mobile viewports.

## Documentation and binaries

Please refer to the [ChirpStack](https://www.chirpstack.io/) website for
documentation and pre-compiled binaries.

## Building from source

### Requirements

Building ChirpStack requires:

* [Nix](https://nixos.org/download.html) (recommended) and
* [Docker](https://www.docker.com/)

#### Nix

Nix is used for setting up the development environment which is used for local
development and for creating the binaries.

If you do not have Nix installed and do not wish to install it, then you can
use the provided Docker Compose based Nix environment. To start this environment
execute the following command:

```bash
make docker-devshell
```

**Note:** You will be able to run the test commands and run `cargo build`, but
cross-compiling will not work within this environment (because it would try start
Docker within Docker).

#### Docker

Docker is used by [cross-rs](https://github.com/cross-rs/cross) for cross-compiling,
 as well as some of the `make` commands.

### Starting the development shell

Run the following command to start the development shell:

```bash
nix-shell
```

Or if you do not have Nix installed, execute the following command:

```bash
make docker-devshell
```

### Building the UI

To build the ChirpStack UI, execute the following command:

```
make build-ui
```

### Running ChirpStack tests

#### Start required services

ChirpStack requires several services like PostgresQL, Redis, Mosquitto, ...
to be running before you can run the tests. You need to start these services
manually if you started the development shell using `nix-shell`:

```bash
docker compose up -d
```

#### Run tests

Run the following command to run the ChirpStack tests:

```bash
# Test (with PostgresQL database backend)
make test

# Test with SQLite database backend
DATABASE=sqlite make test
```

### Building ChirpStack binaries

Before compiling the binaries, you need to install some additional development
tools (for cross-compiling, packaging, e.d.). Execute the following command:

```bash
make dev-dependencies
```

Run the following command within the `./chirpstack` sub-folder:

```bash
# Build AMD64 debug build (optimized for build speed)
make debug-amd64

# Build AMD64 release build (optimized for performance and binary size)
make release-amd64

# Build all packages (all targets, .deb, .rpm and .tar.gz files)
make dist
```

By default the above commands will build ChirpStack with the PostgresQL database
database backend. Set the `DATABASE=sqlite` env. variable to compile ChirpStack
with the SQLite database backend.

### Database migrations

To create a new database migration, execute:

```
make migration-generate NAME=test-migration
```

To apply migrations, execute:

```
make migration-run
```

To revert a migration, execute:

```
make migration-revert
```

By default the above commands will execute the migration commands using the
PostgresQL database backend. To execute migration commands for the SQLite
database backend, set the `DATABASE=sqlite` env. variable.

## License

ChirpStack Network Server is distributed under the MIT license. See also
[LICENSE](https://github.com/brocaar/chirpstack/blob/master/LICENSE).
