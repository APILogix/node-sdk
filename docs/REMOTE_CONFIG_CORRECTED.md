# Remote configuration (superseded)

This document previously described the legacy polling/default-merge configuration model. That model has been removed.

Use:

- [Remote configuration architecture](REMOTE_CONFIGURATION.md) for the implemented two-endpoint flow, lifecycle, validation, atomic replacement, and failure semantics.
- [`../REMOTE_CONFIG_EXAMPLE.json`](../REMOTE_CONFIG_EXAMPLE.json) for the complete schema-v1 config document.

The authoritative rules are: one `POST /v1/init` at startup, `POST /v1/sdk-config` only after a telemetry `202/change:true` signal, complete snapshots only, no polling, no background config retry, and no local policy overrides.
