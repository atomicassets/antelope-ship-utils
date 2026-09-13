# @atomichub/antelope-ship-utils

[![npm version](https://img.shields.io/npm/v/@atomichub/antelope-ship-utils.svg)](https://www.npmjs.com/package/@atomichub/antelope-ship-utils)
[![CI](https://github.com/atomicassets/antelope-ship-utils/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/atomicassets/antelope-ship-utils/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@atomichub/antelope-ship-utils.svg)](https://github.com/atomicassets/antelope-ship-utils/blob/main/LICENSE)

A State History Plugin (SHIP) client for Antelope chains. It opens a
websocket to a node's SHIP endpoint, deserializes the blocks, traces, and
deltas the node streams back, and drives a consumer over the result.

The package exports `StateHistoryConnection`, the websocket client that
requests blocks from SHIP and reconnects when the connection drops;
`ShipConsumer`, which paces block delivery against an
`IProcessedBlockRepository` so a restart resumes where it left off;
`BlockProcessor`, which routes each block's traces and deltas to the trace
and delta listeners registered on it; `EOSJsDeserializer`, which turns raw
SHIP bytes into typed data and can run the deserialization in worker
threads; and `LocalAbiProvider`, an in-memory ABI cache backed by an
Antelope RPC endpoint.

## Install

```sh
pnpm add @atomichub/antelope-ship-utils
```

## Usage

The shapes below come straight from the constructors in `src/`. Treat this
as a sketch: a real consumer supplies its own repository, trace and delta
listeners, and error handling.

```ts
import {
    StateHistoryConnection,
    ShipConsumer,
    BlockProcessor,
    EOSJsDeserializer,
    LocalAbiProvider,
    LocalBlockRepository,
} from '@atomichub/antelope-ship-utils';

const deserializer = new EOSJsDeserializer({ threads: 4 });

const abiProvider = new LocalAbiProvider({
    rpcEndpoint: 'https://wax.greymass.com',
    fetchApi: fetch,
});

const processor = new BlockProcessor({
    deserializer,
    abiProvider,
    failOnDeserializationError: false,
    traceListeners: [
        {
            account: 'atomicassets',
            name: 'logmint',
            processor: async ({ trace, block }) => {
                // handle the deserialized trace
            },
        },
    ],
});

// A real repository persists the cursor; this one starts from a fixed block.
const repository = new LocalBlockRepository(300000000);

const consumer = new ShipConsumer({ repository, processor, blockDelay: 0 });

const connection = new StateHistoryConnection({
    endpoint: 'wss://wax.greymass.com/ship',
    deserializer,
});

connection.on('error', (err) => {
    // see "Error handling" below: the queue does not resume on its own
});

await connection.startProcessing(consumer);
```

ABI `float32` and `float64` fields decode to JavaScript numbers rather than
to the strings `@wharfkit/antelope` renders for them.
`deserializeEosioType` runs its result through `objectifyNumericFloats`,
which the package also exports for a consumer that objectifies a decoded
value itself. The walk matches `Serializer.objectify` everywhere else, and a
`float32` comes back as the stored 32-bit value widened to a double, so
`0.6197762` reads as `0.61977618932724`. A `float128` keeps its hex string,
and the 64-bit integers keep the shape `Serializer.objectify` gives them, a decimal
string above the 32-bit range and a number at or below it.

The serialization helpers behind `BlockProcessor` are exported for a
consumer that runs its own processing loop: `extractShipTraces` and
`extractShipDeltas` turn a SHIP payload into flat traces and rows
(`extractShipDeltas` returns only the delta names listed in its
`serializedDeltas` argument, so pass `['contract_row']` for contract
rows; the default list is empty and yields no rows),
`getActionAbiType` and `getTableAbiType` resolve a struct name from an
ABI, `deserializeEosioType` and `serializeEosioType` decode and encode a
value against it, and `deserializeAbi` decodes the bytes an
`eosio::setabi` action publishes. `deserializeEosioType` takes an
`ignoreInvalidUTF8` option as its fourth argument for a string field that
carries bytes no UTF-8 sequence allows; the default throws, as
`@wharfkit/antelope` does.

## Stored ABIs

`StoredAbiProvider` keeps the ABI history of the accounts a consumer
listens to in a durable store, so a restart or a replay decodes each block
with the ABI a `setabi` published for it. The consumer implements `IAbiStore`
over its own table and passes it as `store`, next to `accounts` (the
accounts it registers listeners for), `rpcEndpoint`, and `fetchApi`.

The store holds published ABIs only: every row the provider saves comes
from an `eosio::setabi` at that block. Every lookup, `loadLatestPerAccount`
included, returns only rows that carry an ABI and sit above `block_num` 0,
so a row another provider wrote at block 0 never answers as a published
ABI. `findOlder` returns rows strictly below its block, newest first, and
`save` is idempotent on `(account, block_num)`.

`init` loads the newest row for each account. `getAbi` answers from up to
eight rows per account held in memory, then from the store, then from the
chain. A chain ABI is held in memory for the account and never saved, so
the table keeps published history only. `setAbi` saves the published row;
when the save fails, the cached row keeps answering. Save calls reach the
store one at a time, in the order of the `setabi` actions, so the last
`setabi` for an account in a block is the stored row.

`accounts` limits only what `init` loads. The provider saves every
`setabi` the processor passes it, and `BlockProcessor` passes the `setabi`
of `eosio` and of every account a listener matches, so a wildcard listener
makes the `setabi` of every account on the chain a stored row. A consumer
that stores ABIs registers listeners for explicit accounts.

The provider is an `EventEmitter` and emits `warn` as
`(message: string, error?: Error)`, the shape `BlockProcessor` uses, so one
listener serves both. It warns when it answers with a chain ABI, when a
save fails, and when `refresh` finds a chain ABI that differs from the
cached one.

`refresh(account, blockNum)` is an optional `IAbiProvider` method. With
`failOnDeserializationError` on, `BlockProcessor` calls it once per account
per block when a cached ABI lacks a table or action type, or when no stored
ABI decodes a row, and retries once with the ABI it returns. While the
failures persist, the provider fetches the chain ABI at most once per
account for each cached ABI in every `refreshIntervalBlocks` blocks, an
optional constructor parameter with a default of 1200. It returns `null`
when the chain ABI matches, and otherwise replaces the cached ABI in memory
only. A new `setabi` for the account, or a `rollback`, allows the next
fetch inside the interval. When the reader runs behind the chain head, the
chain ABI can be later than the block, so the replaced ABI can decode rows
of that account with the later ABI or drop them. Each replacement emits
`warn` and lasts until the next `setabi` for that account, a `rollback`
below its block, or a restart.

`rollback(blockNum)` drops every cached row above `blockNum`. It also
restores the published ABI of a row that a refresh above `blockNum`
replaced, and drops a chain ABI fetched for a block above `blockNum`, so
memory keeps nothing from a discarded block. Call it from the consumer's
fork path before the replay starts. It does not touch the
store. If the consumer's store writes are not part of the transaction the
fork rollback undoes, the store keeps the row from a forked-out block.

## IShipConnectionOptions

Passed as `connectionOptions` to `StateHistoryConnection`. Every field is
optional; the defaults are the ones `StateHistoryConnection` applies.

| Option | Default | Meaning |
| --- | --- | --- |
| `min_block_confirmation` | `1` | Blocks to accumulate before the client acks them back to the node. |
| `allow_empty_traces` | `false` | Accept a block whose trace payload is empty instead of treating it as a stalled node and reconnecting. |
| `allow_empty_deltas` | `false` | Same, for an empty delta payload. |
| `allow_empty_blocks` | `false` | Same, for an empty block payload. |
| `heartbeat_interval_ms` | `30000` | Interval between websocket pings while connected. |
| `idle_timeout_ms` | `300000` | Terminate the socket, and reconnect, once this long passes with no message or pong, catching a half-open connection whose peer disappeared without a close frame. |
| `max_blocks_queue` | `0` | Ceiling on the block queue: while the queue holds at least this many blocks the ack is withheld, so the node stops at `max_messages_in_flight` until the queue drains and the accumulated count goes out in one ack. A withheld ack does not trip the idle timeout, because the heartbeat pong keeps refreshing the activity clock. Zero applies no ceiling. |

## Error handling

A consumer rejection or a deserialization failure emits `'error'` on the
`StateHistoryConnection` with a `ShipError`, then clears and pauses the
block queue and rejects the queued task that failed. The rejection is not
caught anywhere in the package, so it surfaces as an unhandled rejection in
the host process. Nothing in the package resumes the paused queue: a
consumer that wants to keep running past an error needs to call
`startProcessing()` again after handling the failure.

## Lineage

This package reworks [eosio-ship-utils](https://www.npmjs.com/package/eosio-ship-utils)
on npm, which is unmaintained, and carries the protocol's current name,
Antelope, in place of the EOSIO name the predecessor used. See `NOTICE` for
the attribution. Use this package instead for SHIP clients on Antelope chains.

## Development

```sh
pnpm install
pnpm run build
pnpm test
pnpm run lint
pnpm run check-types
```

## Releasing

See [RELEASING.md](./RELEASING.md).
