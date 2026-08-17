# Changelog

All notable changes to this project are documented here.

## [1.0.0]

Initial standalone release, reworked from eosio-ship-utils 0.0.16 (see NOTICE).

### Features

- Migrates from eosjs to @wharfkit/antelope for name and ABI encoding, and keeps the on-wire name encoding backward compatible with the predecessor.
- Adds a heartbeat ping and an idle-timeout watchdog, so a half-open socket whose peer disappeared without a close frame gets torn down and reconnected instead of hanging.
- Adds exponential reconnect backoff, from 5 seconds up to a 60-second ceiling.
- Reconnects on an empty SHIP payload instead of pausing the block queue forever.
- Retries deserialization against older cached ABIs when the current ABI version does not match the payload.
- Emits a per-listener timing breakdown from BlockProcessor, so a slow trace or delta listener is identifiable.

### Bug fixes

- Fixes a websocket error path that could strand the reconnect state machine instead of retrying.
- Keeps the ShipError cause chain intact, so a wrapped error such as a Postgres error code survives up to the caller.
- Skips a trace or delta that fails to deserialize instead of crashing the whole block.
- Guards against calling terminate() before the deserializer has initialized.

### Other changes

- Adopts strict TypeScript types throughout.
