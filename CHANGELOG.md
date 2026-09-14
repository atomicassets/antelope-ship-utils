# Changelog

All notable changes to this project are documented here.

## [2.2.0]

### Features

- Adds `StoredAbiProvider`, an ABI provider over a durable store the consumer implements through the exported `IAbiStore` and `IAbiStoreRow` types. It keeps up to eight published ABIs per account in memory, each under the block that published it, reads older history from the store, and answers an account with no published row from the chain's current ABI held in memory and never saved. It emits `warn` as `(message, error?)` when it answers with a chain ABI, when a save fails, and when a refresh finds a changed ABI, and exposes `rollback(blockNum)` for the consumer's fork path. Saves reach the store one at a time in the order of the `setabi` actions. The optional `refreshIntervalBlocks` parameter, default 1200, sets how many blocks a refresh that found an equal ABI skips the next fetch.
- `IAbiProvider` gains an optional `refresh(account, blockNum)`, which `BlockProcessor` calls when a cached ABI lacks a type or no stored ABI decodes a row. The "Stored ABIs" section of the README gives the conditions and the retry. The endings do not change: a type still missing stops the block. A row still undecodable is dropped with a `warn` when the provider has `getOlderAbis`, and the processor throws when the provider lacks it. A provider without `refresh` keeps its behavior.

### Other changes

- `BlockProcessor` prewarms ABIs only for the accounts of the deltas a listener takes, the same rule the trace path applies, so a provider fetches no ABI for an account nothing deserializes. Decoded output does not change.

## [2.1.0]

### Features

- Exports the serialization helpers `extractShipTraces`, `extractShipDeltas`, `getActionAbiType`, `getTableAbiType`, `deserializeEosioType`, `serializeEosioType`, and `deserializeAbi`, so a consumer that runs its own processing loop decodes with the same code `BlockProcessor` uses instead of a copy. `deserializeEosioType` takes an options object as its fourth argument with `ignoreInvalidUTF8`, off by default, for a string field whose bytes no UTF-8 sequence allows; a boolean there is the legacy unused `checkLength` flag and still compiles. The `block` argument of the two extract functions is optional: neither reads it. The public `ShipActionTrace` and `ShipTableDelta` types admit the `action_trace_v1` and `table_delta_v1` variants the extractors already handle, so a consumer passes a v1 payload without a cast.

## [2.0.1]

### Bug fixes

- Stores the ABI an `eosio::setabi` action publishes again. The setabi guard accepted the `abi` field only as a `Uint8Array`, while the objectified decode renders a `bytes` field as a hex string, so every published ABI was dropped without a log line and consumers kept deserializing with the ABI they held before the change. `deserializeAbi` now accepts the hex string as well as the raw bytes. A consumer that ran an affected version needs its stored ABIs checked against the chain for every contract that published an ABI in that period.

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
