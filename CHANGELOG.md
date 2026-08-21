# Changelog

All notable changes to this project are documented here.

## [2.0.0]

### Breaking changes

- ABI `float32` and `float64` fields decode to JavaScript numbers in place of the strings `@wharfkit/antelope` renders for them. The `float32` string held seven decimal places rather than the seven significant digits a `float32` carries, so a value needing more than seven fractional decimals lost information on the way to JSON. Sampling over 20,000 random float32 values per decade found that none failed to round-trip at or above 1, 41% failed in [0.5, 1), 87% failed in [0.1, 0.2), and 99% failed in [0.01, 0.02); every sampled value at or below 0.001 failed to round-trip, while the float32 form of 0.001 itself round-trips. A consumer that persisted floats decoded by 1.x holds those strings and needs a one-time rewrite, for which the atomicassets-api repair is the reference. (#4)

### Features

- Exports `objectifyNumericFloats`, the float-aware walk `deserializeEosioType` now returns through, for a consumer that objectifies a decoded value itself. It matches `Serializer.objectify` apart from the two float types, so a `float128` keeps its hex string and the 64-bit integers keep their objectified shape, a decimal string above the 32-bit range. (#4)

## [1.0.1]

### Bug fixes

- Logs the block request with the have_positions count in place of the array. The array holds one 64-character block id per tracked reversible block, so a mainnet consumer wrote tens of kilobytes at info on every connect and reconnect. (#1)

## [1.0.0]

Initial standalone release, reworked from eosio-ship-utils 0.0.16 (see NOTICE).

### Features

- Migrates from eosjs to @wharfkit/antelope for name and ABI encoding, and keeps the on-wire name encoding backward compatible with the predecessor.
- Adds a heartbeat ping and an idle-timeout watchdog, so a half-open socket whose peer disappeared without a close frame gets torn down and reconnected instead of hanging.
- Adds exponential reconnect backoff, from 5 seconds up to a 60-second ceiling.
- Reconnects on an empty SHIP payload instead of pausing the block queue forever.
- Adds max_blocks_queue ack backpressure: while the block queue sits at or above the ceiling, the ack the node needs before it sends past max_messages_in_flight is withheld, and the accumulated count goes out in one ack once the queue drains.
- Retries deserialization against older cached ABIs when the current ABI version does not match the payload.
- Emits a per-listener timing breakdown from BlockProcessor, so a slow trace or delta listener is identifiable.

### Bug fixes

- Fixes a websocket error path that could strand the reconnect state machine instead of retrying.
- Handles get_blocks_result_v2 messages instead of logging them as unsupported. The result-version table listed the version while the dispatch guard in front of the block path left it out.
- Keeps the ShipError cause chain intact, so a wrapped error such as a Postgres error code survives up to the caller.
- Skips a trace or delta that fails to deserialize instead of crashing the whole block.
- Guards against calling terminate() before the deserializer has initialized.

### Other changes

- Adopts strict TypeScript types throughout.
- Opens the SHIP socket with permessage-deflate disabled, so a node that offers compression never gets it negotiated on frames that are already dense binary.
